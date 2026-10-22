import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Core } from '../../src/bootstrap/core';
import { WagerTransactionKind as Kind } from '../../src/domain/wagering/wager-transaction-types';
import { expectAllWalletsConsistent, expectWalletConsistent } from '../support/consistency';
import { createTestCore } from '../support/core';
import { TestDatabase } from '../support/database';
import { httpCommand, payload, sqsCommand, uniqueId, waitFor } from '../support/fixtures';
import { ServiceProcess, stopAll } from '../support/processes';
import { TestQueues } from '../support/sqs';

describe('The same operation submitted 50 times concurrently', () => {
  let db: TestDatabase;
  let queues: TestQueues;
  let core: Core;
  const services: ServiceProcess[] = [];

  beforeAll(async () => {
    db = await TestDatabase.create('burst');
    queues = await TestQueues.create('burst');
    core = await createTestCore(db, { queues: queues.names, env: { DB_POOL_MAX: '50' } });
    const started = await Promise.all([
      ...[1, 2, 3].map(() => ServiceProcess.start({ kind: 'api', dbName: db.name, queues: queues.names })),
      ...[1, 2, 3].map(() =>
        ServiceProcess.start({
          kind: 'consumer',
          dbName: db.name,
          queues: queues.names,
          env: { SQS_WAIT_TIME_SECONDS: '1' },
        }),
      ),
    ]);
    services.push(...started);
  });

  afterAll(async () => {
    await stopAll(services);
    await expectAllWalletsConsistent(db);
    await core.close();
    await queues.destroy();
    await db.drop();
  });

  async function openWallet() {
    const playerId = uniqueId('player');
    const walletId = (
      await core.createWallet.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
        correlationId: 'c',
      })
    ).id;
    return { walletId, playerId };
  }

  async function assertSingleDebit(walletId: string, amount: string, expectedBalance: string): Promise<void> {
    const rows = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET'`,
      [walletId],
    );
    expect(rows[0]?.count).toBe(1);
    const debits = await db.query<{ amount: string }>(
      `SELECT amount::text FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`,
      [walletId],
    );
    expect(debits).toEqual([{ amount }]);
    expect((await expectWalletConsistent(db, walletId)).balance).toBe(expectedBalance);
  }

  test('50 parallel calls of the use case (real connections): one debit, 49 replays of the same transaction', async () => {
    const { walletId, playerId } = await openWallet();
    const command = httpCommand(payload({ walletId, playerId, kind: Kind.Bet, amount: '25.00' }));
    const results = await Promise.all(Array.from({ length: 50 }, () => core.processWager.execute(command)));
    expect(results.filter((result) => result.type === 'RECORDED')).toHaveLength(1);
    expect(results.filter((result) => result.type === 'REPLAY')).toHaveLength(49);
    const ids = new Set(
      results.map((result) =>
        result.type === 'RECORDED' || result.type === 'REPLAY' ? result.transaction.transactionId : '',
      ),
    );
    expect(ids.size).toBe(1);
    // every replay reports the original balance
    expect(
      results.every(
        (result) =>
          (result.type === 'RECORDED' || result.type === 'REPLAY') &&
          result.transaction.balance?.amount === '75.00',
      ),
    ).toBe(true);
    await assertSingleDebit(walletId, '25.00', '75.00');
  });

  test('50 parallel HTTP requests spread over 3 API processes: one 201, 49 identical 200 replays', async () => {
    const { walletId, playerId } = await openWallet();
    const body = payload({ walletId, playerId, kind: Kind.Bet, amount: '30.00' });
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        fetch(`${services[index % 3]!.url}/wagering/transactions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `provider-a:${body.externalTransactionId}`,
          },
          body: JSON.stringify(body),
        }),
      ),
    );
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 200)).toHaveLength(49);
    const bodies = (await Promise.all(responses.map((response) => response.json()))) as Array<{
      transactionId: string;
      balance: { amount: string };
    }>;
    expect(new Set(bodies.map((item) => item.transactionId)).size).toBe(1);
    expect(new Set(bodies.map((item) => item.balance.amount))).toEqual(new Set(['70.00']));
    await assertSingleDebit(walletId, '30.00', '70.00');
  });

  test('the same operation via HTTP (3 instances) AND SQS (3 consumer processes) at the same time: one effect', async () => {
    const { walletId, playerId } = await openWallet();
    const body = payload({ walletId, playerId, kind: Kind.Bet, amount: '40.00' });
    const key = `provider-a:${body.externalTransactionId}`;
    const http = Array.from({ length: 25 }, (_, index) =>
      fetch(`${services[index % 3]!.url}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(body),
      }),
    );
    const sqs = Array.from({ length: 25 }, (_, index) =>
      queues.sendWager({ messageId: uniqueId(`msg-${index}`), data: { ...body, idempotencyKey: key } }),
    );
    const responses = await Promise.all(http);
    await Promise.all(sqs);
    expect(responses.every((response) => response.status === 200 || response.status === 201)).toBe(true);

    await waitFor(
      async () => {
        const counts = await queues.counts(queues.urls.transactionsQueueUrl);
        return counts.visible + counts.inFlight === 0;
      },
      { timeoutMs: 60_000, description: 'all 25 messages consumed' },
    );
    const inbox = await db.query<{ outcome: string }>(
      `SELECT outcome FROM inbox_messages WHERE transaction_id = (SELECT id FROM wager_transactions WHERE external_transaction_id = $1)`,
      [body.externalTransactionId],
    );
    expect(inbox).toHaveLength(25);
    await assertSingleDebit(walletId, '40.00', '60.00');
  });

  test('same SQS operation from many messages before any HTTP call: SQS records once, everyone else replays', async () => {
    const { walletId, playerId } = await openWallet();
    const body = payload({ walletId, playerId, kind: Kind.Bet, amount: '10.00' });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        core.processWager.execute(sqsCommand(body, uniqueId(`direct-${index}`))),
      ),
    );
    expect(results.filter((result) => result.type === 'RECORDED')).toHaveLength(1);
    expect(results.filter((result) => result.type === 'REPLAY')).toHaveLength(19);
    await assertSingleDebit(walletId, '10.00', '90.00');
  });
});
