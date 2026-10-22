import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { RetrySchedule } from '../../shared/backoff';
import type { EventPublisher, PublishResult } from '../ports/event-publisher.port';
import type { WageringMetrics } from '../ports/metrics.port';
import type { UnitOfWork } from '../ports/persistence.ports';
import type { Clock, FaultInjector, Logger } from '../ports/runtime.ports';

export interface OutboxPublishOptions {
  batchSize: number;
  leaseMs: number;
  retry: RetrySchedule;
}

export interface OutboxBatchResult {
  claimed: number;
  published: number;
  failed: number;
  dead: number;
}

/**
 * Publishes committed events (at-least-once):
 *   1. short transaction: claim due events with FOR UPDATE SKIP LOCKED and a
 *      persistent lease (claimed_by, claim_expires_at), then COMMIT;
 *   2. publish to SQS with NO database transaction or lock open;
 *   3. short transaction: mark published (or persist the backoff / DEAD).
 * If the process dies between 2 and 3 the lease expires, another worker
 * claims the event again and republishes it with the same eventId: a
 * duplicate is possible, a loss is not.
 */
export class PublishOutboxBatchUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: WageringMetrics,
    private readonly logger: Logger,
    private readonly faults: FaultInjector,
    private readonly options: OutboxPublishOptions,
  ) {}

  async execute(workerId: string): Promise<OutboxBatchResult> {
    const claimedAt = this.clock.now();
    const claimed = await this.uow.run((scope) =>
      scope.outbox.claimDue({
        now: claimedAt,
        workerId,
        leaseUntil: new Date(claimedAt.getTime() + this.options.leaseMs),
        limit: this.options.batchSize,
      }),
    );
    if (claimed.length === 0) {
      return { claimed: 0, published: 0, failed: 0, dead: 0 };
    }
    await this.faults.checkpoint('outbox.after-claim');

    let results: PublishResult[];
    try {
      results = await this.publisher.publish(claimed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results = claimed.map((event) => ({ id: event.id, ok: false, error: message }));
    }
    await this.faults.checkpoint('outbox.after-publish-before-confirm');

    const now = this.clock.now();
    const byId = new Map(claimed.map((event) => [event.id, event]));
    const publishedIds = results.filter((result) => result.ok).map((result) => result.id);
    if (publishedIds.length > 0) {
      await this.uow.run((scope) => scope.outbox.markPublished(publishedIds, now));
      const delays = publishedIds.map(
        (id) => (now.getTime() - (byId.get(id)?.occurredAt.getTime() ?? now.getTime())) / 1000,
      );
      this.metrics.outboxPublished(publishedIds.length, delays);
    }

    const failures = results.filter((result) => !result.ok);
    let dead = 0;
    for (const failure of failures) {
      const event = byId.get(failure.id) as OutboxMessage;
      event.scheduleRetry(now, this.options.retry, failure.error ?? 'unknown publish error');
      const saved = await this.uow.run((scope) => scope.outbox.saveRetry(event, workerId));
      if (saved && !event.isPending()) {
        dead += 1;
        this.logger.error('Outbox event retained as DEAD after exhausting retries', {
          eventId: event.id,
          eventType: event.eventType,
          aggregateId: event.aggregateId,
          attempts: event.attempts,
          alert: 'OUTBOX_EVENT_DEAD',
        });
      }
    }
    if (failures.length > 0) {
      this.metrics.outboxPublishFailed(failures.length);
      this.logger.warn('Outbox publication failed for some events', {
        failed: failures.length,
        claimed: claimed.length,
      });
    }
    if (dead > 0) {
      this.metrics.outboxDeadLettered(dead);
    }
    return { claimed: claimed.length, published: publishedIds.length, failed: failures.length, dead };
  }
}
