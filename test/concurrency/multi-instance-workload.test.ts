import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomInt } from 'node:crypto';
import type { Core } from '../../src/bootstrap/core';
import { Money } from '../../src/domain/money/money';
import { WagerTransactionKind as Kind } from '../../src/domain/wagering/wager-transaction-types';
import { expectAllWalletsConsistent, expectWalletConsistent } from '../support/consistency';
import { createTestCore } from '../support/core';
import { TestDatabase } from '../support/database';
import { payload, uniqueId, waitFor } from '../support/fixtures';
import { ServiceProcess, stopAll } from '../support/processes';
import { TestQueues } from '../support/sqs';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

/**
 * Mixed workload over >= 3 instances of every component, as real OS
 * processes: 3 API processes (HTTP), 3 consumer processes (SQS) and a
 * reference worker, all on the same PostgreSQL. Expected balances are
 * computed independently with exact decimal arithmetic.
 */
describe('Multi-instance workload: parallel wallets + one hot wallet', () => {
  let db: TestDatabase;
  let queues: TestQueues;
  let core: Core;
  const services: ServiceProcess[] = [];

  beforeAll(async () => {
    db = await TestDatabase.create('workload');
    queues = await TestQueues.create('workload');
    core = await createTestCore(db, { queues: queues.names });
    const consumerEnv = { SQS_WAIT_TIME_SECONDS: '1' };
    services.push(
      ...(await Promise.all([
        ...[1, 2, 3].map(() => ServiceProcess.start({ kind: 'api', dbName: db.name, queues: queues.names })),
        ...[1, 2, 3].map(() =>
          ServiceProcess.start({ kind: 'consumer', dbName: db.name, queues: queues.names, env: consumerEnv }),
        ),
        ServiceProcess.start({
          kind: 'reference-worker',
          dbName: db.name,
          queues: queues.names,
          env: { REFERENCE_RETRY_INITIAL_MS: '200', REFERENCE_POLL_INTERVAL_MS: '100' },
        }),
      ])),
    );
  });

  afterAll(async () => {
    await stopAll(services);
    await expectAllWalletsConsistent(db);
    await core.close();
    await queues.destroy();
    await db.drop();
  });

  const apis = () => services.filter((service) => service.kind === 'api');

  async function post(body: ReturnType<typeof payload>, apiIndex: number): Promise<number> {
    const api = apis()[apiIndex % 3]!;
    const response = await fetch(`${api.url}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `${body.providerId}:${body.externalTransactionId}`,
      },
      body: JSON.stringify(body),
    });
    await response.arrayBuffer();
    return response.status;
  }

  test('30 wallets x 20 operations in parallel over HTTP and SQS: every balance matches the expected sum', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 30 }, async () => {
        const playerId = uniqueId('player');
        const walletId = (
          await core.createWallet.execute({
            playerId,
            initialBalance: { amount: '500.00', currency: 'BRL' },
            correlationId: 'c',
          })
        ).id;
        return { walletId, playerId };
      }),
    );
    // Small amounts so no BET can ever be rejected: the expected balance is deterministic.
    const plan = wallets.map(({ walletId, playerId }) => {
      let expected = brl('500.00');
      const operations = Array.from({ length: 20 }, () => {
        const kind = randomInt(2) === 0 ? Kind.Bet : Kind.Win;
        const amount = `${randomInt(1, 10)}.${String(randomInt(0, 100)).padStart(2, '0')}`;
        expected = kind === Kind.Bet ? expected.subtract(brl(amount)) : expected.add(brl(amount));
        return payload({ walletId, playerId, kind, amount });
      });
      return { walletId, operations, expected };
    });

    const work: Array<Promise<unknown>> = [];
    plan.forEach(({ operations }, walletIndex) => {
      operations.forEach((operation, index) => {
        if (index % 2 === 0) work.push(post(operation, walletIndex + index));
        else work.push(queues.sendWager({ messageId: uniqueId('msg'), data: operation }));
      });
    });
    await Promise.all(work);

    await waitFor(
      async () => {
        const row = await db.one<{ count: number }>(
          `SELECT count(*)::int AS count FROM wager_transactions WHERE kind <> 'OPENING'`,
        );
        return row.count >= 600;
      },
      { timeoutMs: 120_000, intervalMs: 500, description: '600 transactions recorded' },
    );
    for (const { walletId, expected } of plan) {
      const audit = await expectWalletConsistent(db, walletId);
      expect(audit.balance).toBe(expected.amount);
      expect(audit.version).toBe(21);
    }
  });

  test('hot wallet: 300 concurrent operations from 3 APIs + 3 consumers, including out-of-order refunds', async () => {
    const playerId = uniqueId('player');
    const walletId = (
      await core.createWallet.execute({
        playerId,
        initialBalance: { amount: '10000.00', currency: 'BRL' },
        correlationId: 'c',
      })
    ).id;
    let expected = brl('10000.00');
    const operations: Array<{ body: ReturnType<typeof payload>; channel: 'http' | 'sqs' }> = [];
    for (let index = 0; index < 100; index += 1) {
      const betId = uniqueId('bet');
      const round = uniqueId('round');
      const amount = `${randomInt(1, 50)}.${String(randomInt(0, 100)).padStart(2, '0')}`;
      operations.push({
        body: payload({
          walletId,
          playerId,
          kind: Kind.Bet,
          amount,
          externalTransactionId: betId,
          roundId: round,
        }),
        channel: 'http',
      });
      if (index % 3 === 0) {
        // Refund sent possibly BEFORE its bet (random interleaving): money comes back.
        operations.push({
          body: payload({ walletId, playerId, kind: Kind.Refund, amount, reference: betId, roundId: round }),
          channel: 'sqs',
        });
      } else {
        expected = expected.subtract(brl(amount));
        operations.push({
          body: payload({
            walletId,
            playerId,
            kind: Kind.Loss,
            amount: '0.00',
            reference: betId,
            roundId: round,
          }),
          channel: 'http',
        });
      }
      const win = `${randomInt(0, 20)}.${String(randomInt(1, 100)).padStart(2, '0')}`;
      expected = expected.add(brl(win));
      operations.push({
        body: payload({ walletId, playerId, kind: Kind.Win, amount: win, roundId: round }),
        channel: 'sqs',
      });
    }
    // Shuffle to create out-of-order arrivals.
    for (let index = operations.length - 1; index > 0; index -= 1) {
      const swap = randomInt(index + 1);
      [operations[index], operations[swap]] = [operations[swap]!, operations[index]!];
    }

    await Promise.all(
      operations.map((operation, index) =>
        operation.channel === 'http'
          ? post(operation.body, index)
          : queues.sendWager({
              messageId: uniqueId('msg'),
              data: operation.body,
              groupId: uniqueId('group'),
            }),
      ),
    );

    await waitFor(
      async () => {
        const row = await db.one<{ settled: number }>(
          `SELECT count(*)::int AS settled FROM wager_transactions WHERE wallet_id = $1 AND kind <> 'OPENING' AND status IN ('PROCESSED','REJECTED')`,
          [walletId],
        );
        return row.settled === operations.length;
      },
      { timeoutMs: 120_000, intervalMs: 500, description: 'every hot-wallet operation settled' },
    );
    const rejected = await db.query(
      `SELECT failure_code FROM wager_transactions WHERE wallet_id = $1 AND status = 'REJECTED'`,
      [walletId],
    );
    expect(rejected).toEqual([]);
    const audit = await expectWalletConsistent(db, walletId);
    expect(audit.balance).toBe(expected.amount);
    const contention = await Promise.all(
      apis().map(async (api) => (await fetch(`${api.url}/metrics`)).text()),
    );
    expect(contention.some((text) => /wagering_wallet_lock_contention_total\{[^}]*\} [1-9]/.test(text))).toBe(
      true,
    );
  });
});
