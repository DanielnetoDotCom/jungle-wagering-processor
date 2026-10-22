import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { WagerSubmissionResult } from '../../src/application/use-cases/process-wager-transaction.use-case';
import type { Core } from '../../src/bootstrap/core';
import { WagerTransactionKind as Kind } from '../../src/domain/wagering/wager-transaction-types';
import { expectAllWalletsConsistent, expectWalletConsistent } from '../support/consistency';
import { createTestCore } from '../support/core';
import { TestDatabase } from '../support/database';
import { httpCommand, payload, uniqueId } from '../support/fixtures';
import { ServiceProcess, stopAll } from '../support/processes';
import { TestQueues } from '../support/sqs';

/**
 * Mandatory scenario: balance 100.00, two simultaneous BETs of 80.00.
 * Expected: exactly one PROCESSED, one REJECTED (INSUFFICIENT_FUNDS), final
 * balance 20.00, exactly one DEBIT, and no retry can debit again.
 */
describe('Two concurrent 80.00 bets on a 100.00 wallet', () => {
  let db: TestDatabase;
  let queues: TestQueues;
  let core: Core;
  const apis: ServiceProcess[] = [];

  beforeAll(async () => {
    db = await TestDatabase.create('race');
    queues = await TestQueues.create('race'); // readiness checks SQS too
    core = await createTestCore(db, { queues: queues.names, env: { DB_POOL_MAX: '40' } });
    apis.push(
      ...(await Promise.all(
        [1, 2, 3].map(() => ServiceProcess.start({ kind: 'api', dbName: db.name, queues: queues.names })),
      )),
    );
  });

  afterAll(async () => {
    await stopAll(apis);
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

  async function assertOutcome(walletId: string): Promise<void> {
    const statuses = await db.query<{ status: string; failure_code: string | null }>(
      `SELECT status, failure_code FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET' ORDER BY status`,
      [walletId],
    );
    expect(statuses).toEqual([
      { status: 'PROCESSED', failure_code: null },
      { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' },
    ]);
    const debits = await db.one<{ count: number }>(
      `SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`,
      [walletId],
    );
    expect(debits.count).toBe(1);
    const audit = await expectWalletConsistent(db, walletId);
    expect(audit.balance).toBe('20.00');
    expect(audit.version).toBe(2);
  }

  test('in one process, on separate pooled connections (repeated on 25 wallets in parallel)', async () => {
    const wallets = await Promise.all(Array.from({ length: 25 }, () => openWallet()));
    const commands = wallets.map(({ walletId, playerId }) => [
      httpCommand(
        payload({
          walletId,
          playerId,
          kind: Kind.Bet,
          amount: '80.00',
          externalTransactionId: uniqueId('bet-a'),
        }),
      ),
      httpCommand(
        payload({
          walletId,
          playerId,
          kind: Kind.Bet,
          amount: '80.00',
          externalTransactionId: uniqueId('bet-b'),
        }),
      ),
    ]);
    const results = await Promise.all(commands.flat().map((command) => core.processWager.execute(command)));
    expect(results.every((result) => result.type === 'RECORDED')).toBe(true);
    for (const { walletId } of wallets) await assertOutcome(walletId);

    // Retrying both requests (any number of times) changes nothing.
    const retries = await Promise.all(
      commands
        .flat()
        .flatMap((command) => [core.processWager.execute(command), core.processWager.execute(command)]),
    );
    expect(retries.every((result: WagerSubmissionResult) => result.type === 'REPLAY')).toBe(true);
    for (const { walletId } of wallets) await assertOutcome(walletId);
  });

  test('across three independent API processes, each bet hitting a different instance (repeated 10 times)', async () => {
    for (let round = 0; round < 10; round += 1) {
      const { walletId, playerId } = await openWallet();
      const bodies = [uniqueId('bet-a'), uniqueId('bet-b')].map((externalTransactionId) =>
        payload({ walletId, playerId, kind: Kind.Bet, amount: '80.00', externalTransactionId }),
      );
      const send = (index: number, api: ServiceProcess) =>
        fetch(`${api.url}/wagering/transactions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `provider-a:${bodies[index]?.externalTransactionId}`,
          },
          body: JSON.stringify(bodies[index]),
        });
      const responses = await Promise.all([send(0, apis[round % 3]!), send(1, apis[(round + 1) % 3]!)]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 422]);
      await assertOutcome(walletId);

      // Client retries after e.g. a timeout, through yet another instance.
      const retries = await Promise.all([send(0, apis[(round + 2) % 3]!), send(1, apis[(round + 2) % 3]!)]);
      expect(retries.map((response) => response.status).sort()).toEqual([200, 422]);
      await assertOutcome(walletId);
    }
  });
});
