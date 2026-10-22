import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { Core } from '../../src/bootstrap/core';
import { WagerTransactionKind as Kind } from '../../src/domain/wagering/wager-transaction-types';
import { expectAllWalletsConsistent, expectWalletConsistent } from '../support/consistency';
import { createTestCore } from '../support/core';
import { TestDatabase } from '../support/database';
import { httpCommand, payload, uniqueId, waitFor } from '../support/fixtures';
import { ServiceProcess, stopAll } from '../support/processes';
import { TestQueues } from '../support/sqs';

/**
 * Crashes are REAL: the process kills itself with SIGKILL at a precise step
 * (FAULT_INJECTION), so no shutdown hook, ack or confirmation can run.
 */
describe('Crash recovery with real process deaths', () => {
  let db: TestDatabase;
  let queues: TestQueues;
  let core: Core;
  const services: ServiceProcess[] = [];

  const crashAt = (point: string) => ({ FAULT_INJECTION_ENABLED: 'true', FAULT_INJECTION: `${point}=crash` });
  const fastSqs = { SQS_WAIT_TIME_SECONDS: '1', SQS_VISIBILITY_TIMEOUT_SECONDS: '3' };

  beforeAll(async () => {
    db = await TestDatabase.create('crash');
    queues = await TestQueues.create('crash', { visibilityTimeoutSeconds: 3, maxReceiveCount: 5 });
    core = await createTestCore(db, { queues: queues.names });
  });

  afterEach(async () => {
    await stopAll(services.splice(0));
  });

  afterAll(async () => {
    await expectAllWalletsConsistent(db);
    await core.close();
    await queues.destroy();
    await db.drop();
  });

  async function openWallet(amount = '100.00') {
    const playerId = uniqueId('player');
    const walletId = (
      await core.createWallet.execute({
        playerId,
        initialBalance: { amount, currency: 'BRL' },
        correlationId: 'c',
      })
    ).id;
    return { walletId, playerId };
  }

  async function start(
    kind: Parameters<typeof ServiceProcess.start>[0]['kind'],
    env: Record<string, string> = {},
    waitUntilReady = true,
  ) {
    const service = await ServiceProcess.start({
      kind,
      dbName: db.name,
      queues: queues.names,
      env: { ...fastSqs, ...env },
      waitUntilReady,
    });
    services.push(service);
    return service;
  }

  test('consumer killed AFTER the commit and BEFORE the ack: redelivery is absorbed by the inbox (one effect)', async () => {
    const { walletId, playerId } = await openWallet();
    const doomed = await start('consumer', crashAt('consumer.after-commit-before-ack'));
    const messageId = uniqueId('msg');
    await queues.sendWager({
      messageId,
      data: payload({ walletId, playerId, kind: Kind.Bet, amount: '15.00' }),
    });

    await doomed.exited;
    expect(doomed.signalCode).toBe('SIGKILL');

    // The commit happened: transaction + inbox are durable...
    const inbox = await db.one<{ status: string; outcome: string }>(
      `SELECT status, outcome FROM inbox_messages WHERE message_id = $1`,
      [messageId],
    );
    expect(inbox).toEqual({ status: 'PROCESSED', outcome: 'APPLIED' });
    // ...but the message was never deleted.
    const counts = await queues.counts(queues.urls.transactionsQueueUrl);
    expect(counts.visible + counts.inFlight).toBe(1);

    const survivor = await start('consumer');
    await waitFor(
      async () => {
        const after = await queues.counts(queues.urls.transactionsQueueUrl);
        return after.visible + after.inFlight === 0;
      },
      { timeoutMs: 30_000, description: 'redelivered message acked by the new consumer' },
    );
    const metrics = await (await fetch(`${survivor.url}/metrics`)).text();
    expect(metrics).toMatch(/wagering_inbox_duplicates_total\{[^}]*\} 1/);
    const debits = await db.one<{ count: number }>(
      `SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`,
      [walletId],
    );
    expect(debits.count).toBe(1);
    expect((await expectWalletConsistent(db, walletId)).balance).toBe('85.00');
  });

  test('outbox publisher killed AFTER publishing and BEFORE confirming: another instance republishes, nothing is lost', async () => {
    await queues.drain(queues.urls.eventsQueueUrl, { waitSeconds: 0 });
    const { walletId, playerId } = await openWallet();
    await core.processWager.execute(
      httpCommand(payload({ walletId, playerId, kind: Kind.Bet, amount: '1.00' })),
    );
    const expected = (
      await db.query<{ id: string }>(`SELECT id FROM outbox_messages WHERE status = 'PENDING'`)
    ).map((row) => row.id);
    expect(expected.length).toBeGreaterThan(0);

    // It may die before its health endpoint is even listening: do not wait for readiness.
    const doomed = await start(
      'outbox-worker',
      { ...crashAt('outbox.after-publish-before-confirm'), OUTBOX_LEASE_MS: '3000' },
      false,
    );
    await doomed.exited;
    expect(doomed.signalCode).toBe('SIGKILL');
    const stuck = await db.query<{ status: string; attempts: number; claimed_by: string | null }>(
      `SELECT status, attempts, claimed_by FROM outbox_messages WHERE id = ANY($1)`,
      [expected],
    );
    expect(
      stuck.every((row) => row.status === 'PENDING' && row.attempts === 1 && row.claimed_by !== null),
    ).toBe(true);

    await start('outbox-worker', { OUTBOX_LEASE_MS: '3000', OUTBOX_POLL_INTERVAL_MS: '100' });
    await waitFor(
      async () => {
        const rows = await db.query<{ status: string }>(
          `SELECT status FROM outbox_messages WHERE id = ANY($1)`,
          [expected],
        );
        return rows.every((row) => row.status === 'PUBLISHED');
      },
      { timeoutMs: 30_000, description: 'events confirmed by the second publisher after the lease expired' },
    );
    const attempts = await db.query<{ attempts: number }>(
      `SELECT attempts FROM outbox_messages WHERE id = ANY($1)`,
      [expected],
    );
    expect(attempts.every((row) => row.attempts === 2)).toBe(true);

    const delivered = (await queues.drain(queues.urls.eventsQueueUrl)).map(
      (message) => (JSON.parse(message.Body ?? '{}') as { eventId: string }).eventId,
    );
    // At-least-once: every event arrived (possibly twice), each identified by its stable eventId.
    expect([...new Set(delivered)].sort()).toEqual([...expected].sort());
  });

  test('API killed after writing and BEFORE COMMIT: nothing persisted; the client retry is applied exactly once', async () => {
    const { walletId, playerId } = await openWallet();
    const body = payload({ walletId, playerId, kind: Kind.Bet, amount: '20.00' });
    const send = (api: ServiceProcess) =>
      fetch(`${api.url}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `provider-a:${body.externalTransactionId}`,
        },
        body: JSON.stringify(body),
      });

    const doomed = await start('api', crashAt('wager.before-commit'));
    await expect(send(doomed)).rejects.toThrow();
    await doomed.exited;
    const leftovers = await db.query(`SELECT 1 FROM wager_transactions WHERE external_transaction_id = $1`, [
      body.externalTransactionId,
    ]);
    expect(leftovers).toEqual([]);
    expect((await expectWalletConsistent(db, walletId)).balance).toBe('100.00');

    const healthy = await start('api');
    expect((await send(healthy)).status).toBe(201);
    expect((await send(healthy)).status).toBe(200);
    expect((await expectWalletConsistent(db, walletId)).balance).toBe('80.00');
  });

  test('restart under load: consumers SIGKILLed and SIGTERMed mid-stream, replacements finish, every operation applied once', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet('100.00')));
    const consumers = await Promise.all([start('consumer'), start('consumer'), start('consumer')]);
    await start('reference-worker', { REFERENCE_RETRY_INITIAL_MS: '300', REFERENCE_POLL_INTERVAL_MS: '100' });

    const sent: string[] = [];
    for (const { walletId, playerId } of wallets) {
      const betId = uniqueId('bet');
      // refund first (out of order), then its bet, then a win: net effect +win
      for (const operation of [
        payload({ walletId, playerId, kind: Kind.Refund, amount: '10.00', reference: betId }),
        payload({ walletId, playerId, kind: Kind.Bet, amount: '10.00', externalTransactionId: betId }),
        payload({ walletId, playerId, kind: Kind.Win, amount: '2.50' }),
      ]) {
        await queues.sendWager({ messageId: uniqueId('msg'), data: operation, groupId: uniqueId('g') });
        sent.push(operation.externalTransactionId);
      }
    }

    await waitFor(
      async () =>
        (await db.one<{ count: number }>(`SELECT count(*)::int AS count FROM inbox_messages`)).count > 5,
      {
        description: 'processing started',
      },
    );
    await consumers[0].kill(); // abrupt
    await consumers[1].stop(); // graceful SIGTERM: finishes in-flight, releases the rest
    await start('consumer');
    await start('consumer');

    await waitFor(
      async () => {
        const row = await db.one<{ settled: number }>(
          `SELECT count(*)::int AS settled FROM wager_transactions WHERE external_transaction_id = ANY($1) AND status IN ('PROCESSED','REJECTED','FAILED')`,
          [sent],
        );
        return row.settled === sent.length;
      },
      { timeoutMs: 90_000, intervalMs: 500, description: 'all 60 operations settled' },
    );
    const statuses = await db.query<{ status: string; count: number }>(
      `SELECT status, count(*)::int AS count FROM wager_transactions WHERE external_transaction_id = ANY($1) GROUP BY status`,
      [sent],
    );
    expect(statuses).toEqual([{ status: 'PROCESSED', count: 60 }]);
    for (const { walletId } of wallets) {
      expect((await expectWalletConsistent(db, walletId)).balance).toBe('102.50');
    }
    expect((await queues.counts(queues.urls.transactionsDlqUrl)).visible).toBe(0);
  });
});
