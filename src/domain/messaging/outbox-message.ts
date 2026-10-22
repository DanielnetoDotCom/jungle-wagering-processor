import type { RetrySchedule } from '../../shared/backoff';
import { InvalidTransactionStateError } from '../errors/domain-errors';
import type { IntegrationEvent } from '../events/integration-event';

export enum OutboxStatus {
  Pending = 'PENDING',
  Published = 'PUBLISHED',
  /** Retries exhausted: retained for operational intervention, never dropped. */
  Dead = 'DEAD',
}

export interface OutboxMessageState {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  messageGroupId: string;
  correlationId: string;
  causationId: string | undefined;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | undefined;
  lastError: string | undefined;
}

const MAX_ERROR_LENGTH = 1000;

/**
 * Event waiting to be published after the financial commit. `id` is the
 * eventId and doubles as the SQS deduplication id: republishing after a crash
 * produces the same message identity, so consumers can deduplicate.
 * `attempts` counts publication attempts started (incremented when claimed).
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateType: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly eventVersion: number,
    public readonly messageGroupId: string,
    public readonly correlationId: string,
    public readonly causationId: string | undefined,
    public readonly payload: Readonly<Record<string, unknown>>,
    private readonly _occurredAt: Date,
    private _status: OutboxStatus,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt: Date | undefined,
    private _lastError: string | undefined,
  ) {
    this._occurredAt = new Date(_occurredAt.getTime());
    this._nextAttemptAt = new Date(_nextAttemptAt.getTime());
    this._publishedAt = _publishedAt && new Date(_publishedAt.getTime());
  }

  static enqueue(event: IntegrationEvent<unknown>, aggregateType: string): OutboxMessage {
    const envelope = event.toJSON();
    return new OutboxMessage(
      event.eventId,
      aggregateType,
      event.aggregateId,
      event.eventType,
      event.version,
      event.messageGroupId(),
      event.correlationId,
      event.causationId,
      Object.freeze(JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>),
      event.occurredAt,
      OutboxStatus.Pending,
      0,
      event.occurredAt,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateType,
      state.aggregateId,
      state.eventType,
      state.eventVersion,
      state.messageGroupId,
      state.correlationId,
      state.causationId,
      state.payload,
      state.occurredAt,
      state.status,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.lastError,
    );
  }

  get status(): OutboxStatus {
    return this._status;
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date {
    return new Date(this._nextAttemptAt.getTime());
  }

  get occurredAt(): Date {
    return new Date(this._occurredAt.getTime());
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt && new Date(this._publishedAt.getTime());
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._status === OutboxStatus.Pending;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (this._status === OutboxStatus.Published) {
      return;
    }
    this._status = OutboxStatus.Published;
    this._publishedAt = new Date(at.getTime());
    this._lastError = undefined;
  }

  /** After a failed attempt: backs off, or retains the event as DEAD once retries are exhausted. */
  scheduleRetry(now: Date, schedule: RetrySchedule, error: string): void {
    if (this._status !== OutboxStatus.Pending) {
      throw new InvalidTransactionStateError(`Outbox message ${this.id} is ${this._status}`);
    }
    this._lastError = error.slice(0, MAX_ERROR_LENGTH);
    if (this._attempts >= schedule.maxAttempts) {
      this._status = OutboxStatus.Dead;
      return;
    }
    this._nextAttemptAt = new Date(now.getTime() + schedule.delayAfterAttempt(this._attempts));
  }
}
