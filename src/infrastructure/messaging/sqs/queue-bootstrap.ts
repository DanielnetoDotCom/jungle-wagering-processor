import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SetQueueAttributesCommand,
  type QueueAttributeName,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { Logger } from '../../../application/ports/runtime.ports';
import type { AppConfig } from '../../configuration/config';

type Attributes = Partial<Record<QueueAttributeName, string>>;

export interface QueueTopology {
  transactionsQueueUrl: string;
  transactionsDlqUrl: string;
  eventsQueueUrl: string;
}

const FOURTEEN_DAYS = String(14 * 24 * 3600);
const FOUR_DAYS = String(4 * 24 * 3600);

/**
 * Idempotent creation of the FIFO queues. Safe to run on every deployment:
 * existing queues get their (mutable) attributes re-applied.
 *  - wager-transactions.fifo  -> redrive to the DLQ after maxReceiveCount
 *  - wager-transactions-dlq.fifo
 *  - wager-events.fifo        -> integration events published by the outbox
 */
export async function ensureQueues(
  sqs: SQSClient,
  config: AppConfig,
  logger: Logger,
): Promise<QueueTopology> {
  const fifo: Attributes = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };

  const transactionsDlqUrl = await ensureQueue(
    sqs,
    config.sqs.transactionsDlq,
    { ...fifo, MessageRetentionPeriod: FOURTEEN_DAYS },
    logger,
  );
  const dlqArn = await queueArn(sqs, transactionsDlqUrl);

  const transactionsQueueUrl = await ensureQueue(
    sqs,
    config.sqs.transactionsQueue,
    {
      ...fifo,
      VisibilityTimeout: String(config.sqs.visibilityTimeoutSeconds),
      ReceiveMessageWaitTimeSeconds: String(config.sqs.waitTimeSeconds),
      MessageRetentionPeriod: FOUR_DAYS,
      DeduplicationScope: 'messageGroup',
      FifoThroughputLimit: 'perMessageGroupId',
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount: config.sqs.maxReceiveCount,
      }),
    },
    logger,
  );

  const eventsQueueUrl = await ensureQueue(
    sqs,
    config.sqs.eventsQueue,
    {
      ...fifo,
      MessageRetentionPeriod: FOURTEEN_DAYS,
      DeduplicationScope: 'messageGroup',
      FifoThroughputLimit: 'perMessageGroupId',
    },
    logger,
  );

  return { transactionsQueueUrl, transactionsDlqUrl, eventsQueueUrl };
}

async function ensureQueue(
  sqs: SQSClient,
  name: string,
  attributes: Attributes,
  logger: Logger,
): Promise<string> {
  try {
    const created = await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
    if (!created.QueueUrl) throw new Error(`CreateQueue returned no URL for ${name}`);
    logger.info('Queue ready', { queue: name });
    return created.QueueUrl;
  } catch (error) {
    if (!(error instanceof Error) || !/QueueNameExists|QueueAlreadyExists/.test(error.name)) {
      throw error;
    }
    const existing = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!existing.QueueUrl) throw new Error(`Queue ${name} exists but has no URL`, { cause: error });
    const { FifoQueue: _immutable, ...mutable } = attributes;
    await sqs.send(new SetQueueAttributesCommand({ QueueUrl: existing.QueueUrl, Attributes: mutable }));
    logger.info('Queue already existed; attributes re-applied', { queue: name });
    return existing.QueueUrl;
  }
}

async function queueArn(sqs: SQSClient, queueUrl: string): Promise<string> {
  const response = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
  );
  const arn = response.Attributes?.QueueArn;
  if (!arn) throw new Error(`Queue ${queueUrl} has no ARN`);
  return arn;
}
