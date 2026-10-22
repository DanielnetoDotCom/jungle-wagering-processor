import {
  SendMessageBatchCommand,
  type SendMessageBatchRequestEntry,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishResult } from '../../../application/ports/event-publisher.port';
import type { OutboxMessage } from '../../../domain/messaging/outbox-message';
import type { QueueUrlResolver } from './sqs-client';

const SQS_BATCH_LIMIT = 10;

/**
 * Publishes outbox events to the FIFO events queue.
 *  - MessageDeduplicationId = eventId: a republish after a crash inside the
 *    SQS deduplication window is dropped by SQS; outside it, consumers
 *    deduplicate by eventId (at-least-once).
 *  - MessageGroupId = walletId: per-wallet ordering for consumers.
 * Chunks are sent sequentially; a failed chunk does not fail the others.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: QueueUrlResolver,
    private readonly queueName: string,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishResult[]> {
    const queueUrl = await this.queues.resolve(this.queueName);
    const results: PublishResult[] = [];
    for (let index = 0; index < messages.length; index += SQS_BATCH_LIMIT) {
      const chunk = messages.slice(index, index + SQS_BATCH_LIMIT);
      try {
        const response = await this.sqs.send(
          new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: chunk.map(toEntry) }),
        );
        for (const success of response.Successful ?? []) {
          if (success.Id) results.push({ id: success.Id, ok: true });
        }
        for (const failure of response.Failed ?? []) {
          if (failure.Id)
            results.push({
              id: failure.Id,
              ok: false,
              error: `${failure.Code ?? 'Error'}: ${failure.Message ?? ''}`,
            });
        }
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        results.push(...chunk.map((event) => ({ id: event.id, ok: false, error: message })));
      }
    }
    return results;
  }
}

function toEntry(event: OutboxMessage): SendMessageBatchRequestEntry {
  return {
    Id: event.id,
    MessageBody: JSON.stringify(event.payload),
    MessageGroupId: event.messageGroupId,
    MessageDeduplicationId: event.id,
    MessageAttributes: {
      eventType: { DataType: 'String', StringValue: event.eventType },
      eventVersion: { DataType: 'Number', StringValue: String(event.eventVersion) },
      correlationId: { DataType: 'String', StringValue: event.correlationId },
    },
  };
}
