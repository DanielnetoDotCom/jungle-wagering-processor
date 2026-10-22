export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string | undefined;
  occurredAt: Date;
  data: T;
}

/** What a factory needs besides the aggregate: identity and tracing of the event itself. */
export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string | undefined;
  occurredAt: Date;
}

/** Serialized envelope stored in the outbox payload and published as the message body. */
export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  version: number;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  data: T;
}

/**
 * Base class of every integration event. `eventType` and `version` live in
 * the concrete type (never as loose strings at call sites); `data` must be
 * JSON-stable, so money travels as MoneyProps decimal strings.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = new Date(props.occurredAt.getTime());
    this.data = Object.freeze({ ...props.data });
  }

  /** Message group used for ordered delivery: events of one wallet share a group. */
  abstract messageGroupId(): string;

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      version: this.version,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      data: { ...this.data },
    };
  }
}
