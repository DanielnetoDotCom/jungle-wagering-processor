import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface PublishResult {
  id: string;
  ok: boolean;
  error?: string;
}

/** Broker adapter. Must use the event id as deduplication id so republishing is safe. */
export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<PublishResult[]>;
}
