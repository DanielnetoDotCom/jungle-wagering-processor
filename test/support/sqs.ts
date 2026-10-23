import { randomBytes } from 'node:crypto';
import {
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { ensureQueues, type QueueTopology } from '../../src/infrastructure/messaging/sqs/queue-bootstrap';
import type { WagerTransactionPayload } from '../../src/application/commands/wager-commands';
import { silentLogger } from './database';
import { testConfig, testInfra, type TestQueueNames } from './environment';

/** Dedicated FIFO queues per test file (same topology as production, unique names). */
export class TestQueues {
  private constructor(
    readonly names: TestQueueNames,
    readonly urls: QueueTopology,
    readonly sqs: SQSClient,
  ) {}

  static async create(
    label: string,
    options: {
      visibilityTimeoutSeconds?: number;
      maxReceiveCount?: number;
      consumerMaxAttempts?: number;
    } = {},
  ): Promise<TestQueues> {
    const suffix = `${label}-${randomBytes(4).toString('hex')}`;
    const names: TestQueueNames = {
      transactionsQueue: `t-${suffix}-transactions.fifo`,
      transactionsDlq: `t-${suffix}-transactions-dlq.fifo`,
      eventsQueue: `t-${suffix}-events.fifo`,
    };
    const config = testConfig({
      dbName: 'unused',
      queues: names,
      extra: {
        SQS_VISIBILITY_TIMEOUT_SECONDS: String(options.visibilityTimeoutSeconds ?? 30),
        SQS_MAX_RECEIVE_COUNT: String(options.maxReceiveCount ?? 100),
        CONSUMER_MAX_ATTEMPTS: String(options.consumerMaxAttempts ?? 5),
      },
    });
    const sqs = new SQSClient({
      region: testInfra.awsRegion,
      endpoint: testInfra.awsEndpoint,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const urls = await ensureQueues(sqs, config, silentLogger);
    return new TestQueues(names, urls, sqs);
  }

  async sendWager(params: {
    messageId: string;
    data: WagerTransactionPayload & { idempotencyKey?: string };
    deduplicationId?: string;
    raw?: string;
    groupId?: string;
  }): Promise<string> {
    const body =
      params.raw ??
      JSON.stringify({
        messageId: params.messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          ...params.data,
          idempotencyKey:
            params.data.idempotencyKey ?? `${params.data.providerId}:${params.data.externalTransactionId}`,
        },
      });
    const response = await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.urls.transactionsQueueUrl,
        MessageBody: body,
        MessageGroupId: params.groupId ?? params.data.walletId,
        MessageDeduplicationId:
          params.deduplicationId ?? `${params.messageId}-${randomBytes(4).toString('hex')}`,
      }),
    );
    return response.MessageId ?? '';
  }

  async sendRaw(body: string, groupId: string): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.urls.transactionsQueueUrl,
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: randomBytes(8).toString('hex'),
      }),
    );
  }

  /** Approximate counts (visible, in flight) of a queue. */
  async counts(queueUrl: string): Promise<{ visible: number; inFlight: number }> {
    const response = await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    return {
      visible: Number(response.Attributes?.ApproximateNumberOfMessages ?? 0),
      inFlight: Number(response.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
    };
  }

  /** Drains a queue (receive + delete) until it stays empty for one long poll. */
  async drain(
    queueUrl: string,
    options: { waitSeconds?: number; maxRounds?: number } = {},
  ): Promise<Message[]> {
    const received: Message[] = [];
    for (let round = 0; round < (options.maxRounds ?? 50); round += 1) {
      const response = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: options.waitSeconds ?? 1,
          MessageSystemAttributeNames: ['All'],
          MessageAttributeNames: ['All'],
        }),
      );
      const messages = response.Messages ?? [];
      if (messages.length === 0) break;
      for (const message of messages) {
        received.push(message);
        await this.sqs.send(
          new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
        );
      }
    }
    return received;
  }

  async destroy(): Promise<void> {
    for (const url of Object.values(this.urls)) {
      await this.sqs.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => undefined);
    }
    this.sqs.destroy();
  }
}
