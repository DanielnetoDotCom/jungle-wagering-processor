import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { EventPublisher, PublishResult } from '../../src/application/ports/event-publisher.port';
import { BacklogQueries } from '../../src/application/queries/backlog-queries';
import type { Core } from '../../src/bootstrap/core';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { WagerTransactionKind as Kind } from '../../src/domain/wagering/wager-transaction-types';
import { InboxMessage, InboxOutcome } from '../../src/domain/messaging/inbox-message';
import { QueueUrlResolver } from '../../src/infrastructure/messaging/sqs/sqs-client';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs/sqs-event-publisher';
import { expectAllWalletsConsistent } from '../support/consistency';
import { createTestCore } from '../support/core';
import { TestDatabase } from '../support/database';
import { httpCommand, ManualClock, payload, ScriptedFaults, uniqueId } from '../support/fixtures';
import { TestQueues } from '../support/sqs';

/** Publisher double that fails on demand, then delegates to the real SQS publisher. */
class ToggleablePublisher implements EventPublisher {
  failing = false;
  constructor(private delegate?: EventPublisher) {}
  use(delegate: EventPublisher): void {
    this.delegate = delegate;
  }
  publish(messages: readonly OutboxMessage[]): Promise<PublishResult[]> {
    if (this.failing)
      return Promise.resolve(
        messages.map((message) => ({ id: message.id, ok: false, error: 'broker unavailable' })),
      );
    if (!this.delegate) throw new Error('no delegate');
    return this.delegate.publish(messages);
  }
}

describe('Transactional outbox -> SQS (LocalStack)', () => {
  let db: TestDatabase;
  let queues: TestQueues;
  let clock: ManualClock;
  let faults: ScriptedFaults;
  let publisherA: Core;
  let publisherB: Core;
  let toggle: ToggleablePublisher;
  let writer: Core;

  beforeAll(async () => {
    db = await TestDatabase.create('outbox');
    queues = await TestQueues.create('outbox');
    clock = new ManualClock(new Date());
    faults = new ScriptedFaults();
    const env = {
      OUTBOX_LEASE_MS: '30000',
      OUTBOX_MAX_ATTEMPTS: '3',
      OUTBOX_RETRY_BASE_MS: '1000',
      OUTBOX_BATCH_SIZE: '7',
    };
    writer = await createTestCore(db, { queues: queues.names });
    publisherA = await createTestCore(db, { queues: queues.names, overrides: { clock, faults }, env });
    publisherB = await createTestCore(db, { queues: queues.names, overrides: { clock }, env });
    toggle = new ToggleablePublisher();
  });

  beforeEach(async () => {
    faults.clear();
    // Publisher time runs ahead of the writer's real clock so new events are always due.
    clock.set(new Date(Date.now() + 10 * 60_000));
    await publishEverything();
    await queues.drain(queues.urls.eventsQueueUrl, { waitSeconds: 0 });
  });

  afterAll(async () => {
    await expectAllWalletsConsistent(db);
    await Promise.all([writer.close(), publisherA.close(), publisherB.close()]);
    await queues.destroy();
    await db.drop();
  });

  async function produceEvents(wallets: number): Promise<string[]> {
    const walletIds: string[] = [];
    for (let index = 0; index < wallets; index += 1) {
      const playerId = uniqueId('player');
      const walletId = (
        await writer.createWallet.execute({
          playerId,
          initialBalance: { amount: '10.00', currency: 'BRL' },
          correlationId: 'c',
        })
      ).id;
      await writer.processWager.execute(
        httpCommand(payload({ walletId, playerId, kind: Kind.Bet, amount: '1.00' })),
      );
      walletIds.push(walletId);
    }
    return walletIds;
  }

  async function pendingIds(): Promise<string[]> {
    return (
      await db.query<{ id: string }>(`SELECT id FROM outbox_messages WHERE status = 'PENDING' ORDER BY seq`)
    ).map((row) => row.id);
  }

  async function publishEverything(): Promise<void> {
    for (let round = 0; round < 100; round += 1) {
      const result = await publisherA.publishOutbox.execute('cleanup');
      if (result.claimed === 0) return;
    }
  }

  function eventIdsOf(bodies: Array<{ Body?: string }>): string[] {
    return bodies.map((message) => (JSON.parse(message.Body ?? '{}') as { eventId: string }).eventId);
  }

  test('publishes committed events with eventId as deduplication id and walletId as group', async () => {
    const [walletId] = await produceEvents(1);
    const expected = await pendingIds();
    expect(expected).toHaveLength(4); // opening: Processed + BalanceChanged, bet: Processed + BalanceChanged
    await publisherA.publishOutbox.execute('worker-a');

    const received = await queues.drain(queues.urls.eventsQueueUrl);
    expect(eventIdsOf(received).sort()).toEqual([...expected].sort());
    for (const message of received) {
      expect(message.Attributes?.MessageGroupId).toBe(walletId);
      expect(message.Attributes?.MessageDeduplicationId).toBe(
        (JSON.parse(message.Body ?? '{}') as { eventId: string }).eventId,
      );
      const envelope = JSON.parse(message.Body ?? '{}') as { data: { money?: { amount: unknown } } };
      if (envelope.data.money) expect(typeof envelope.data.money.amount).toBe('string');
    }
    const states = await db.query<{ status: string; attempts: number; claimed_by: string | null }>(
      `SELECT status, attempts, claimed_by FROM outbox_messages WHERE id = ANY($1)`,
      [expected],
    );
    expect(
      states.every((row) => row.status === 'PUBLISHED' && row.attempts === 1 && row.claimed_by === null),
    ).toBe(true);
  });

  test('two concurrent publishers: disjoint claims (SKIP LOCKED), every event published exactly once', async () => {
    await produceEvents(15);
    const expected = await pendingIds();
    expect(expected).toHaveLength(60);
    const loop = async (core: Core, workerId: string) => {
      let claimed = 0;
      for (;;) {
        const result = await core.publishOutbox.execute(workerId);
        if (result.claimed === 0) return claimed;
        claimed += result.claimed;
      }
    };
    const [claimedByA, claimedByB] = await Promise.all([
      loop(publisherA, 'worker-a'),
      loop(publisherB, 'worker-b'),
    ]);
    expect(claimedByA + claimedByB).toBe(60);

    const received = eventIdsOf(await queues.drain(queues.urls.eventsQueueUrl));
    expect(received.length).toBe(60);
    expect(new Set(received).size).toBe(60);
    const attempts = await db.one<{ max: number; published: number }>(
      `SELECT max(attempts)::int AS max, count(*) FILTER (WHERE status = 'PUBLISHED')::int AS published FROM outbox_messages WHERE id = ANY($1)`,
      [expected],
    );
    expect(attempts).toEqual({ max: 1, published: 60 });
  });

  test('broker failure: backoff persisted, event retried later and never lost; DEAD after max attempts', async () => {
    const failing = await createTestCore(db, {
      queues: queues.names,
      overrides: { clock, publisher: toggle },
      env: { OUTBOX_MAX_ATTEMPTS: '3', OUTBOX_RETRY_BASE_MS: '1000' },
    });
    try {
      toggle.use(
        new SqsEventPublisher(queues.sqs, new QueueUrlResolver(queues.sqs), queues.names.eventsQueue),
      );
      await produceEvents(1);
      const ids = await pendingIds();

      toggle.failing = true;
      const first = await failing.publishOutbox.execute('worker-f');
      expect(first).toMatchObject({ claimed: 4, published: 0, failed: 4 });
      let rows = await db.query<{
        attempts: number;
        next_attempt_at: Date;
        last_error: string;
        claimed_by: string | null;
        status: string;
      }>(
        `SELECT attempts, next_attempt_at, last_error, claimed_by, status FROM outbox_messages WHERE id = ANY($1)`,
        [ids],
      );
      expect(
        rows.every((row) => row.status === 'PENDING' && row.attempts === 1 && row.claimed_by === null),
      ).toBe(true);
      expect(rows.every((row) => row.last_error === 'broker unavailable')).toBe(true);
      expect(rows.every((row) => row.next_attempt_at.getTime() > clock.now().getTime())).toBe(true);

      // not due yet
      expect((await failing.publishOutbox.execute('worker-f')).claimed).toBe(0);
      clock.advance(60_000);
      expect((await failing.publishOutbox.execute('worker-f')).failed).toBe(4); // attempt 2
      clock.advance(60_000);
      const third = await failing.publishOutbox.execute('worker-f'); // attempt 3 -> DEAD
      expect(third.dead).toBe(4);
      rows = await db.query(
        `SELECT attempts, next_attempt_at, last_error, claimed_by, status FROM outbox_messages WHERE id = ANY($1)`,
        [ids],
      );
      expect(rows.every((row) => row.status === 'DEAD')).toBe(true);
      expect((await failing.metrics.render()).match(/wagering_outbox_dead_total\{[^}]*\} 4/)).not.toBeNull();

      // Operational intervention: requeue, and the events are published, not lost.
      await db.query(
        `UPDATE outbox_messages SET status = 'PENDING', next_attempt_at = now() - interval '1 second' WHERE id = ANY($1)`,
        [ids],
      );
      clock.advance(60_000);
      await publishEverything();
      expect(eventIdsOf(await queues.drain(queues.urls.eventsQueueUrl)).sort()).toEqual([...ids].sort());
    } finally {
      await failing.close();
    }
  });

  test('crash after SQS publish and before the DB confirmation: lease expires, event republished with the same id, deduplicated downstream', async () => {
    await produceEvents(1);
    const ids = await pendingIds();
    faults.on('outbox.after-publish-before-confirm', () =>
      Promise.reject(new Error('publisher died before confirming')),
    );
    await expect(publisherA.publishOutbox.execute('worker-a')).rejects.toThrow('publisher died');

    // Published to SQS, but the database still says PENDING (claimed, lease running).
    const stuck = await db.query<{ status: string; claimed_by: string; attempts: number }>(
      `SELECT status, claimed_by, attempts FROM outbox_messages WHERE id = ANY($1)`,
      [ids],
    );
    expect(
      stuck.every((row) => row.status === 'PENDING' && row.claimed_by === 'worker-a' && row.attempts === 1),
    ).toBe(true);

    // Another instance cannot take it while the lease is valid...
    expect((await publisherB.publishOutbox.execute('worker-b')).claimed).toBe(0);
    // ...and takes over once it expired.
    clock.advance(30_001);
    expect((await publisherB.publishOutbox.execute('worker-b')).published).toBe(4);
    const done = await db.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM outbox_messages WHERE id = ANY($1)`,
      [ids],
    );
    expect(done.every((row) => row.status === 'PUBLISHED' && row.attempts === 2)).toBe(true);

    // Both publications carried the same eventId. Whatever the broker delivers
    // (SQS FIFO may already drop the copy inside its dedup window), an
    // idempotent consumer keyed by eventId applies each event once.
    const deliveries = eventIdsOf(await queues.drain(queues.urls.eventsQueueUrl));
    expect([...new Set(deliveries)].sort()).toEqual([...ids].sort());
    const redelivered = [...deliveries, ...deliveries]; // force duplicates explicitly
    let applied = 0;
    for (const eventId of redelivered) {
      const firstTime = await writer.uow.run(async (scope) => {
        const existing = await scope.inbox.find('downstream-projection', eventId);
        if (existing?.isProcessed()) return false;
        const message = InboxMessage.receive({
          messageId: eventId,
          consumerName: 'downstream-projection',
          payloadHash: 'c'.repeat(64),
          receiveCount: 1,
          receivedAt: new Date(),
        });
        message.markProcessed(new Date(), { outcome: InboxOutcome.Applied });
        scope.inbox.save(message);
        return true;
      });
      if (firstTime) applied += 1;
    }
    expect(applied).toBe(ids.length);
  });

  test('a publication that keeps dying before its confirmation is retained as DEAD after max attempts, not republished forever', async () => {
    await produceEvents(1);
    const ids = await pendingIds();
    faults.on('outbox.after-publish-before-confirm', () =>
      Promise.reject(new Error('publisher died before confirming')),
    );
    // OUTBOX_MAX_ATTEMPTS=3: every claim is an attempt, even when nobody gets to record its outcome.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(publisherA.publishOutbox.execute('worker-a')).rejects.toThrow('publisher died');
      clock.advance(30_001);
    }
    faults.clear();

    const retired = await publisherB.publishOutbox.execute('worker-b');
    expect(retired).toMatchObject({ claimed: 0, published: 0, dead: 4 });
    const rows = await db.query<{ status: string; attempts: number; claimed_by: string | null }>(
      `SELECT status, attempts, claimed_by FROM outbox_messages WHERE id = ANY($1)`,
      [ids],
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.status === 'DEAD' && row.attempts === 3 && row.claimed_by === null)).toBe(
      true,
    );
    expect(await publisherB.metrics.render()).toMatch(/wagering_outbox_dead_total\{[^}]*\} 4/);
    // Retained for an operator, never republished again on its own.
    clock.advance(30_001);
    expect((await publisherB.publishOutbox.execute('worker-b')).claimed).toBe(0);
  });

  test('outbox lag gauge: age of the oldest unpublished event, back to zero once published', async () => {
    await produceEvents(1);
    const backlog = new BacklogQueries(publisherA.uow, clock);
    const lag = async () => {
      publisherA.metrics.setOutboxBacklog(await backlog.outbox());
      const line = (await publisherA.metrics.render())
        .split('\n')
        .find((row) => row.startsWith('wagering_outbox_lag_seconds{'));
      return Number(line?.slice(line.lastIndexOf(' ') + 1));
    };
    // The publisher's clock runs 10 minutes ahead of the writer: the events are ~600s old for it.
    expect(await lag()).toBeGreaterThan(500);
    await publishEverything();
    expect(await lag()).toBe(0);
  });

  test('events are never visible before the financial commit', async () => {
    const playerId = uniqueId('player');
    const walletId = (
      await writer.createWallet.execute({
        playerId,
        initialBalance: { amount: '10.00', currency: 'BRL' },
        correlationId: 'c',
      })
    ).id;
    await publishEverything();
    await queues.drain(queues.urls.eventsQueueUrl, { waitSeconds: 0 });

    const blocked = await createTestCore(db, { queues: queues.names, overrides: { faults } });
    try {
      faults.on('wager.before-commit', () => Promise.reject(new Error('rolled back')));
      await expect(
        blocked.processWager.execute(
          httpCommand(payload({ walletId, playerId, kind: Kind.Bet, amount: '1.00' })),
        ),
      ).rejects.toThrow('rolled back');
      expect(await pendingIds()).toEqual([]);
      await publishEverything();
      expect(await queues.drain(queues.urls.eventsQueueUrl, { waitSeconds: 1 })).toEqual([]);
    } finally {
      await blocked.close();
    }
  });
});
