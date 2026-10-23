import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Core } from '../../src/bootstrap/core';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus,
} from '../../src/domain/wagering/wager-transaction-types';
import { expectAllWalletsConsistent, expectWalletConsistent } from '../support/consistency';
import { createTestCore } from '../support/core';
import { TestDatabase } from '../support/database';
import { httpCommand, ManualClock, payload, uniqueId } from '../support/fixtures';
import { TestQueues } from '../support/sqs';

/**
 * Out-of-order delivery: REFUND/ROLLBACK before their reference. Time is a
 * ManualClock, so backoff, TTL and leases are exercised without real waits.
 */
describe('Pending references (out-of-order operations)', () => {
  let db: TestDatabase;
  let clock: ManualClock;
  let core: Core;
  let otherWorkerCore: Core;

  beforeAll(async () => {
    db = await TestDatabase.create('references');
    clock = new ManualClock();
    const env = {
      REFERENCE_RETRY_INITIAL_MS: '2000',
      REFERENCE_MAX_ATTEMPTS: '4',
      REFERENCE_TTL_MS: '3600000',
    };
    core = await createTestCore(db, { overrides: { clock }, env });
    // A second, independent composition (own connection pool) plays a competing worker instance.
    otherWorkerCore = await createTestCore(db, { overrides: { clock }, env });
  });

  afterAll(async () => {
    await expectAllWalletsConsistent(db);
    await core.close();
    await otherWorkerCore.close();
    await db.drop();
  });

  async function openWallet(amount: string) {
    const playerId = uniqueId('player');
    const wallet = await core.createWallet.execute({
      playerId,
      initialBalance: { amount, currency: 'BRL' },
      correlationId: 'c',
    });
    return { walletId: wallet.id, playerId };
  }

  async function transaction(providerExternalId: string) {
    return db.one<{
      id: string;
      status: string;
      failure_code: string | null;
      reference_attempts: number;
      next_attempt_at: Date | null;
    }>(
      `SELECT id, status, failure_code, reference_attempts, next_attempt_at FROM wager_transactions WHERE external_transaction_id = $1`,
      [providerExternalId],
    );
  }

  async function runWorkerOnce(target: Core = core, workerId = 'worker-a') {
    const claims = await target.resolvePendingReference.claimDue(workerId, { limit: 50, leaseMs: 30_000 });
    return Promise.all(claims.map((claim) => target.resolvePendingReference.execute(claim, workerId)));
  }

  test('REFUND before its BET: accepted as PENDING_REFERENCE, resolved once the BET arrives', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    const refundId = uniqueId('refund');
    const betId = uniqueId('bet');

    const refund = await core.processWager.execute(
      httpCommand(
        payload({
          walletId,
          playerId,
          kind: Kind.Refund,
          amount: '30.00',
          externalTransactionId: refundId,
          reference: betId,
        }),
      ),
    );
    expect(refund).toMatchObject({
      type: 'RECORDED',
      transaction: { status: 'PENDING_REFERENCE', balance: { amount: '100.00' } },
    });
    const pendingEvent = await db.one<{ event_type: string }>(
      `SELECT event_type FROM outbox_messages WHERE aggregate_id = $1`,
      [(await transaction(refundId)).id],
    );
    expect(pendingEvent.event_type).toBe('WagerTransactionPendingReference');

    // Nothing is due yet: the first attempt is 2s later.
    expect(await runWorkerOnce()).toEqual([]);

    // The BET arrives: it debits, and wakes its dependent up immediately (next_attempt_at = now).
    await core.processWager.execute(
      httpCommand(
        payload({ walletId, playerId, kind: Kind.Bet, amount: '30.00', externalTransactionId: betId }),
      ),
    );
    expect((await transaction(refundId)).next_attempt_at?.getTime()).toBe(clock.now().getTime());

    const results = await runWorkerOnce();
    expect(results).toEqual([
      { type: 'ATTEMPTED', outcome: 'PROCESSED', status: WagerTransactionStatus.Processed },
    ]);
    const settled = await transaction(refundId);
    expect(settled).toMatchObject({ status: 'PROCESSED', reference_attempts: 1 });
    const audit = await expectWalletConsistent(db, walletId);
    expect(audit.balance).toBe('100.00');
  });

  test('backoff, then REJECTED with REFERENCE_NOT_FOUND when attempts are exhausted (event published)', async () => {
    const { walletId, playerId } = await openWallet('10.00');
    const rollbackId = uniqueId('rollback');
    await core.processWager.execute(
      httpCommand(
        payload({
          walletId,
          playerId,
          kind: Kind.Rollback,
          amount: '5.00',
          externalTransactionId: rollbackId,
          reference: uniqueId('never'),
        }),
      ),
    );
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const pending = await transaction(rollbackId);
      if (pending.status !== 'PENDING_REFERENCE') break;
      const dueIn = (pending.next_attempt_at?.getTime() ?? 0) - clock.now().getTime();
      delays.push(dueIn);
      clock.advance(dueIn);
      await runWorkerOnce();
    }
    expect(delays).toEqual([2000, 4000, 8000, 16000]);
    const rejected = await transaction(rollbackId);
    expect(rejected).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      reference_attempts: 4,
    });
    const eventTypes = await db.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_messages WHERE aggregate_id = $1 ORDER BY seq`,
      [rejected.id],
    );
    expect(eventTypes.map((row) => row.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    await expectWalletConsistent(db, walletId);
  });

  test('the default TTL rejects a missing reference before the attempt cap and publishes the rejection', async () => {
    const queues = await TestQueues.create('reference_ttl');
    const ttlClock = new ManualClock(clock.now());
    const target = await createTestCore(db, { queues: queues.names, overrides: { clock: ttlClock } });
    try {
      const { walletId, playerId } = await openWallet('10.00');
      const externalId = uniqueId('ttl-refund');
      const accepted = await target.processWager.execute(
        httpCommand(
          payload({
            walletId,
            playerId,
            kind: Kind.Refund,
            amount: '1.00',
            externalTransactionId: externalId,
            reference: uniqueId('never-arriving'),
          }),
        ),
      );
      expect(accepted.type).toBe('RECORDED');
      const expiresAt = ttlClock.now().getTime() + target.config.reference.ttlMs;
      for (let attempt = 0; attempt < target.config.reference.maxAttempts; attempt += 1) {
        const row = await transaction(externalId);
        if (row.status !== 'PENDING_REFERENCE') break;
        ttlClock.set(row.next_attempt_at as Date);
        await runWorkerOnce(target, 'ttl-worker');
      }
      const row = await transaction(externalId);
      expect(row).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
      expect(row.reference_attempts).toBeLessThan(target.config.reference.maxAttempts);
      expect(ttlClock.now().getTime()).toBeGreaterThanOrEqual(expiresAt);
      expect(ttlClock.now().getTime() - expiresAt).toBeLessThan(target.config.reference.maxDelayMs);
      for (;;) {
        const batch = await target.publishOutbox.execute('ttl-publisher');
        if (batch.claimed === 0) break;
      }
      const events = (await queues.drain(queues.urls.eventsQueueUrl)).map(
        (message) => JSON.parse(message.Body ?? '{}') as { aggregateId: string; eventType: string },
      );
      expect(events.filter((event) => event.aggregateId === row.id).map((event) => event.eventType)).toEqual([
        'WagerTransactionPendingReference',
        'WagerTransactionRejected',
      ]);
      expect((await expectWalletConsistent(db, walletId)).balance).toBe('10.00');
    } finally {
      await target.close();
      await queues.destroy();
    }
  });

  test('competing worker instances on the same due transaction produce exactly one effect', async () => {
    const { walletId, playerId } = await openWallet('50.00');
    const betId = uniqueId('bet');
    const refundIds = Array.from({ length: 8 }, () => uniqueId('refund'));
    for (const refundId of refundIds) {
      await core.processWager.execute(
        httpCommand(
          payload({
            walletId,
            playerId,
            kind: Kind.Refund,
            amount: '20.00',
            externalTransactionId: refundId,
            reference: betId,
          }),
        ),
      );
    }
    await core.processWager.execute(
      httpCommand(
        payload({ walletId, playerId, kind: Kind.Bet, amount: '20.00', externalTransactionId: betId }),
      ),
    );

    // Both instances claim concurrently (SKIP LOCKED => disjoint sets) and also race on
    // the same claim directly, as would happen after a lease expiry.
    const [claimsA, claimsB] = await Promise.all([
      core.resolvePendingReference.claimDue('worker-a', { limit: 50, leaseMs: 30_000 }),
      otherWorkerCore.resolvePendingReference.claimDue('worker-b', { limit: 50, leaseMs: 30_000 }),
    ]);
    const claimed = [...claimsA, ...claimsB].map((claim) => claim.transactionId);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(claimed).toHaveLength(refundIds.length);

    const everyClaimTwice = [...claimsA, ...claimsB].flatMap((claim) => [
      core.resolvePendingReference.execute(claim, 'worker-a'),
      otherWorkerCore.resolvePendingReference.execute(claim, 'worker-b'),
    ]);
    const results = await Promise.all(everyClaimTwice);
    const attempted = results.filter((result) => result.type === 'ATTEMPTED');
    expect(attempted).toHaveLength(refundIds.length);
    expect(results.filter((result) => result.type === 'SKIPPED')).toHaveLength(refundIds.length);

    // One refund wins; the others are refused because the BET was already reversed.
    const statuses = await db.query<{ status: string; failure_code: string | null }>(
      `SELECT status, failure_code FROM wager_transactions WHERE external_transaction_id = ANY($1) ORDER BY status`,
      [refundIds],
    );
    expect(statuses.filter((row) => row.status === 'PROCESSED')).toHaveLength(1);
    expect(statuses.filter((row) => row.failure_code === 'REFERENCE_ALREADY_REVERSED')).toHaveLength(
      refundIds.length - 1,
    );
    const audit = await expectWalletConsistent(db, walletId);
    expect(audit.balance).toBe('50.00');
  });

  test('ROLLBACK waiting for a REFUND that waits for a BET resolves in cascade', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    const [betId, refundId, rollbackId] = [uniqueId('bet'), uniqueId('refund'), uniqueId('rollback')];
    await core.processWager.execute(
      httpCommand(
        payload({
          walletId,
          playerId,
          kind: Kind.Rollback,
          amount: '10.00',
          externalTransactionId: rollbackId,
          reference: refundId,
        }),
      ),
    );
    await core.processWager.execute(
      httpCommand(
        payload({
          walletId,
          playerId,
          kind: Kind.Refund,
          amount: '10.00',
          externalTransactionId: refundId,
          reference: betId,
        }),
      ),
    );
    await core.processWager.execute(
      httpCommand(
        payload({ walletId, playerId, kind: Kind.Bet, amount: '10.00', externalTransactionId: betId }),
      ),
    );

    await runWorkerOnce(); // REFUND resolved -> wakes the ROLLBACK
    expect((await transaction(refundId)).status).toBe('PROCESSED');
    await runWorkerOnce(); // ROLLBACK resolved
    expect((await transaction(rollbackId)).status).toBe('PROCESSED');
    const audit = await expectWalletConsistent(db, walletId);
    expect(audit.balance).toBe('90.00'); // 100 - 10 (bet) + 10 (refund) - 10 (rollback of refund)
  });

  test('an expired lease makes the transaction claimable by another worker', async () => {
    const { walletId, playerId } = await openWallet('10.00');
    const refundId = uniqueId('refund');
    await core.processWager.execute(
      httpCommand(
        payload({
          walletId,
          playerId,
          kind: Kind.Refund,
          amount: '1.00',
          externalTransactionId: refundId,
          reference: uniqueId('late'),
        }),
      ),
    );
    clock.advance(2000);
    const first = await core.resolvePendingReference.claimDue('dead-worker', { limit: 50, leaseMs: 30_000 });
    expect(first.map((claim) => claim.transactionId)).toContain((await transaction(refundId)).id);
    // the claiming worker "dies": the row stays leased...
    expect(
      await otherWorkerCore.resolvePendingReference.claimDue('worker-b', { limit: 50, leaseMs: 30_000 }),
    ).toEqual([]);
    // ...until the lease expires
    clock.advance(30_001);
    const reclaimed = await otherWorkerCore.resolvePendingReference.claimDue('worker-b', {
      limit: 50,
      leaseMs: 30_000,
    });
    expect(reclaimed.map((claim) => claim.transactionId)).toContain((await transaction(refundId)).id);
    await Promise.all(
      reclaimed.map((claim) => otherWorkerCore.resolvePendingReference.execute(claim, 'worker-b')),
    );
    expect((await transaction(refundId)).reference_attempts).toBe(1);
  });
});
