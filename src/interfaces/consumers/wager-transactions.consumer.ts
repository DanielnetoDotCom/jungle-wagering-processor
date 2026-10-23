import { randomUUID } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { ApplicationError, ErrorCategory } from '../../application/errors/application-errors';
import type { FaultInjector, Logger } from '../../application/ports/runtime.ports';
import { wagerPayloadHash } from '../../application/services/payload-hash';
import type { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';
import type { RecordDeadLetterUseCase } from '../../application/use-cases/record-dead-letter.use-case';
import type { RecordFailedAttemptUseCase } from '../../application/use-cases/record-failed-attempt.use-case';
import {
  DomainError,
  InvalidTransactionStateError,
  InvariantViolationError,
} from '../../domain/errors/domain-errors';
import { TransactionChannel } from '../../domain/wagering/wager-transaction-types';
import { ExponentialBackoff } from '../../shared/backoff';
import { sleep } from '../../shared/sleep';
import { enrichLogContext, runWithLogContext } from '../../infrastructure/logging/log-context';
import { describeError } from '../../infrastructure/logging/logger';
import type { QueueUrlResolver } from '../../infrastructure/messaging/sqs/sqs-client';
import type { PrometheusMetrics } from '../../infrastructure/metrics/prometheus-metrics';
import { parseOrThrow } from '../contracts/validation';
import {
  type WagerTransactionRequestedMessage,
  wagerTransactionRequestedMessageSchema,
} from '../contracts/wager-contracts';

export interface ConsumerOptions {
  consumerName: string;
  queueName: string;
  deadLetterQueueName: string;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  maxMessages: number;
  /**
   * Real processing attempts (persisted in `inbox_attempts`) before the
   * consumer dead-letters a message. Not the SQS receive count: see the class doc.
   */
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  shutdownTimeoutMs: number;
  dlqDepthIntervalMs: number;
  /**
   * Probe used to wait out a database outage without consuming messages.
   * Without it, each DATABASE_UNAVAILABLE costs a receive attempt.
   */
  isDatabaseAvailable?: () => Promise<boolean>;
}

/** Acked, or left in the queue to be received again after `retryAfterSeconds`. */
type Outcome = 'acked' | { retryAfterSeconds: number };

/** Shutdown deadline expired: the message was already released to other consumers. */
const RELEASED: Outcome = { retryAfterSeconds: 0 };
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** A probe is a single `SELECT 1`: cheap enough to retry every few seconds. */
const DATABASE_PROBE_MAX_DELAY_MS = 5_000;

/**
 * SQS consumer of `wager-transactions.fifo`.
 *
 *  - Long polling; messages of the same MessageGroupId (walletId) are handled
 *    sequentially, different groups in parallel.
 *  - The SAME use case as HTTP; the inbox row is written in the same SQL
 *    transaction as the financial effect.
 *  - DeleteMessage (ack) only AFTER the commit. A crash or a failed delete
 *    leads to redelivery, which the inbox turns into a no-op.
 *  - Business outcomes (REJECTED, conflicts, unknown wallet) are terminal: ack.
 *  - Transient and unexpected errors: no ack, visibility set to an exponential
 *    backoff with jitter. Each failure is counted in `inbox_attempts`; after
 *    `maxAttempts` the consumer moves the message to the DLQ itself (with the
 *    reason, and DEAD_LETTERED in the inbox).
 *  - The budget is NOT `ApproximateReceiveCount`: the messages behind a failing
 *    head of a FIFO group come back with it on every retry and are postponed
 *    unprocessed, so their receive count grows without any attempt. The queue
 *    redrive (SQS_MAX_RECEIVE_COUNT, much higher) is only a safety net for
 *    failures the consumer cannot count, such as a message that crashes it.
 *  - Database outage: the consumer PAUSES polling until the database answers
 *    again, so an outage of any length costs at most one or two receive
 *    attempts per message instead of pushing every group head to the DLQ
 *    (which would also break the per-wallet order of the FIFO group).
 *  - Permanent errors (invalid contract, message-id reuse) go straight to
 *    the DLQ and are recorded in the inbox as DEAD_LETTERED.
 *  - Visibility is extended while a message is still being processed.
 *  - SIGTERM: stop polling, finish in-flight messages, release the rest.
 *    The current long poll is NOT aborted: cancelling a ReceiveMessage that
 *    SQS already answered would make those messages invisible (and burn one
 *    of their receive attempts) without anyone processing them. The poll ends
 *    within WaitTimeSeconds and whatever it returns is released at once.
 */
export class WagerTransactionsConsumer {
  private running = false;
  private loop: Promise<void> | undefined;
  private readonly backoff: ExponentialBackoff;
  private dlqTimer: ReturnType<typeof setInterval> | undefined;
  private databaseDown = false;
  private abandoned = false;
  private readonly inFlight = new Map<Message, { queueUrl: string; stopHeartbeat?: () => Promise<void> }>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: QueueUrlResolver,
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly recordDeadLetter: RecordDeadLetterUseCase,
    private readonly recordFailedAttempt: RecordFailedAttemptUseCase,
    private readonly metrics: PrometheusMetrics,
    private readonly logger: Logger,
    private readonly faults: FaultInjector,
    private readonly options: ConsumerOptions,
    random: () => number = Math.random,
  ) {
    this.backoff = new ExponentialBackoff(
      {
        baseDelayMs: options.retryBaseMs,
        maxDelayMs: options.retryMaxMs,
        jitterRatio: 0.3,
        maxAttempts: options.maxAttempts,
      },
      random,
    );
  }

  start(): void {
    // A timed-out drain may still be completing SQL. Do not start a second
    // polling loop on this instance until that work has actually returned.
    if (this.loop) return;
    this.running = true;
    this.abandoned = false;
    this.loop = this.run().finally(() => {
      this.loop = undefined;
      this.running = false;
      clearInterval(this.dlqTimer);
    });
    this.dlqTimer = setInterval(() => void this.refreshDlqDepth(), this.options.dlqDepthIntervalMs);
    this.dlqTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (!this.loop) return;
    this.running = false;
    clearInterval(this.dlqTimer);
    this.logger.info('Consumer stopping: finishing in-flight messages', {
      consumer: this.options.consumerName,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let drained: boolean;
    try {
      drained = await Promise.race([
        this.loop.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), this.options.shutdownTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (!drained) {
      this.abandoned = true;
      const owned = [...this.inFlight.entries()];
      // Wait for any heartbeat already sent before releasing. Otherwise that
      // request could finish after the release and make the message invisible again.
      await Promise.all(
        owned.map(async ([message, owner]) => {
          await owner.stopHeartbeat?.();
          await this.release(owner.queueUrl, [message]);
        }),
      );
      this.logger.warn('Consumer shutdown deadline expired; unacknowledged messages released', {
        consumer: this.options.consumerName,
        messages: owned.length,
      });
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  private async run(): Promise<void> {
    const queueUrl = await this.resolveQueueUrl();
    this.logger.info('Consumer started', {
      consumer: this.options.consumerName,
      queue: this.options.queueName,
    });
    let receiveFailures = 0;
    while (this.running) {
      if (this.databaseDown) {
        await this.waitForDatabase();
        continue;
      }
      let messages: Message[];
      try {
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: this.options.maxMessages,
            WaitTimeSeconds: this.options.waitTimeSeconds,
            VisibilityTimeout: this.options.visibilityTimeoutSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
            MessageAttributeNames: ['All'],
          }),
        );
        messages = response.Messages ?? [];
        receiveFailures = 0;
      } catch (error) {
        if (!this.running) break;
        receiveFailures += 1;
        this.logger.warn('ReceiveMessage failed; backing off', { ...describeError(error), receiveFailures });
        await sleep(this.backoff.delayAfterAttempt(Math.min(receiveFailures, 6)));
        continue;
      }
      if (messages.length === 0) continue;
      for (const message of messages) this.inFlight.set(message, { queueUrl });
      this.metrics.sqsMessagesReceived(messages.length);
      if (!this.running) {
        await this.release(queueUrl, messages);
        break;
      }
      await this.processBatch(queueUrl, messages);
    }
    this.logger.info('Consumer stopped', { consumer: this.options.consumerName });
  }

  private async processBatch(queueUrl: string, messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? 'ungrouped';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all([...groups.values()].map((group) => this.processGroup(queueUrl, group)));
  }

  /** Sequential within a group: a failure postpones the rest so the group order is preserved. */
  private async processGroup(queueUrl: string, group: Message[]): Promise<void> {
    for (let index = 0; index < group.length; index += 1) {
      if (!this.running) {
        await this.release(queueUrl, group.slice(index));
        return;
      }
      const message = group[index] as Message;
      if (this.databaseDown) {
        // Do not spend this message's attempt against a database known to be down.
        await this.postpone(queueUrl, group.slice(index), this.retryDelaySeconds(receiveCountOf(message)));
        return;
      }
      const outcome = await this.handle(queueUrl, message);
      if (outcome !== 'acked') {
        // The rest of the group comes back together with the head. This receive
        // is not an attempt for them: their budget in `inbox_attempts` is intact.
        await this.postpone(queueUrl, group.slice(index + 1), outcome.retryAfterSeconds);
        return;
      }
    }
  }

  private async handle(queueUrl: string, message: Message): Promise<Outcome> {
    const receiveCount = receiveCountOf(message);
    const heartbeat = this.startHeartbeat(queueUrl, message);
    const owner = this.inFlight.get(message);
    if (owner) owner.stopHeartbeat = heartbeat;
    try {
      let envelope: WagerTransactionRequestedMessage;
      try {
        envelope = parseOrThrow(
          wagerTransactionRequestedMessageSchema,
          JSON.parse(message.Body ?? ''),
          'message',
        );
      } catch (error) {
        return await this.deadLetter(
          queueUrl,
          message,
          'INVALID_MESSAGE',
          error,
          extractMessageId(message.Body),
          undefined,
        );
      }
      const correlationId = correlationIdOf(envelope, message);
      return await runWithLogContext({ correlationId, messageId: envelope.messageId }, () =>
        this.process(queueUrl, message, envelope, receiveCount, correlationId),
      );
    } finally {
      await heartbeat();
      this.inFlight.delete(message);
    }
  }

  private async process(
    queueUrl: string,
    message: Message,
    envelope: WagerTransactionRequestedMessage,
    receiveCount: number,
    correlationId: string,
  ): Promise<Outcome> {
    const { idempotencyKey, ...payload } = envelope.data;
    enrichLogContext({ walletId: payload.walletId, providerId: payload.providerId });
    let result;
    try {
      result = await this.processWager.execute({
        idempotencyKey,
        payload,
        channel: TransactionChannel.Sqs,
        correlationId,
        causationId: envelope.messageId,
        inbox: { consumerName: this.options.consumerName, messageId: envelope.messageId, receiveCount },
      });
    } catch (error) {
      if (this.abandoned) return RELEASED;
      return this.onProcessingError(queueUrl, message, envelope, receiveCount, error);
    }

    if (this.abandoned) return RELEASED;
    if (result.type === 'MESSAGE_ID_CONFLICT') {
      return this.deadLetter(queueUrl, message, 'MESSAGE_ID_CONFLICT', undefined, undefined, undefined);
    }
    // Committed. A crash right here must lead to a harmless redelivery.
    await this.faults.checkpoint('consumer.after-commit-before-ack');
    await this.ack(queueUrl, message, result.type);
    return 'acked';
  }

  private async onProcessingError(
    queueUrl: string,
    message: Message,
    envelope: WagerTransactionRequestedMessage,
    receiveCount: number,
    error: unknown,
  ): Promise<Outcome> {
    const permanent =
      (error instanceof DomainError &&
        !(error instanceof InvariantViolationError) &&
        !(error instanceof InvalidTransactionStateError)) ||
      (error instanceof ApplicationError &&
        (error.category === ErrorCategory.Validation || error.category === ErrorCategory.Forbidden));
    if (permanent) {
      return this.deadLetter(queueUrl, message, 'INVALID_MESSAGE', error, envelope.messageId, undefined);
    }
    const reason = error instanceof ApplicationError ? error.code : 'UNEXPECTED_ERROR';
    let attempts: number | undefined;
    if (reason === 'DATABASE_UNAVAILABLE' && this.options.isDatabaseAvailable) {
      // An outage is not this message's fault: pause instead of spending its budget.
      if (!this.databaseDown) {
        this.databaseDown = true;
        this.metrics.setConsumerPaused(true);
        this.logger.warn('Database unavailable: pausing consumption until it recovers', {
          consumer: this.options.consumerName,
        });
      }
    } else {
      attempts = await this.countFailedAttempt(envelope.messageId, reason);
      if (this.abandoned) return RELEASED;
      if (attempts !== undefined && attempts >= this.options.maxAttempts) {
        return this.deadLetter(
          queueUrl,
          message,
          'PROCESSING_FAILED',
          error,
          envelope.messageId,
          safeHash(envelope),
        );
      }
    }
    const retryAfterSeconds = this.retryDelaySeconds(attempts ?? receiveCount);
    this.logger.warn('Message processing failed; will be redelivered', {
      reason,
      attempts,
      receiveCount,
      retryAfterSeconds,
      maxAttempts: this.options.maxAttempts,
      ...describeError(error),
    });
    await this.changeVisibility(queueUrl, message, retryAfterSeconds);
    this.metrics.sqsRetryScheduled(reason);
    return { retryAfterSeconds };
  }

  /**
   * Persists one failed attempt. When even that fails (the database is the
   * problem) the message is simply retried: the queue redrive still bounds it.
   */
  private async countFailedAttempt(messageId: string, errorCode: string): Promise<number | undefined> {
    try {
      return await this.recordFailedAttempt.execute({
        consumerName: this.options.consumerName,
        messageId,
        errorCode,
      });
    } catch (error) {
      this.logger.warn(
        'Could not record the failed attempt; retrying without counting it',
        describeError(error),
      );
      return undefined;
    }
  }

  private async deadLetter(
    queueUrl: string,
    message: Message,
    reason: string,
    error: unknown,
    messageId: string | undefined,
    payloadHash: string | undefined,
  ): Promise<Outcome> {
    if (this.abandoned) return RELEASED;
    const receiveCount = receiveCountOf(message);
    const errorCode = error instanceof ApplicationError || error instanceof DomainError ? error.code : reason;
    try {
      const dlqUrl = await this.queues.resolve(this.options.deadLetterQueueName);
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: dlqUrl,
          MessageBody: message.Body ?? '',
          MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letters',
          MessageDeduplicationId: message.MessageId,
          MessageAttributes: {
            deadLetterReason: { DataType: 'String', StringValue: reason },
            errorCode: { DataType: 'String', StringValue: errorCode },
            consumer: { DataType: 'String', StringValue: this.options.consumerName },
            originalMessageId: {
              DataType: 'String',
              StringValue: messageId ?? message.MessageId ?? 'unknown',
            },
            receiveCount: { DataType: 'Number', StringValue: String(receiveCount) },
          },
        }),
      );
    } catch (sendError) {
      // Could not move it: keep the message in the source queue (redrive policy is the safety net).
      this.logger.error('Failed to move message to the DLQ; it will be retried', describeError(sendError));
      const retryAfterSeconds = this.retryDelaySeconds(receiveCount);
      await this.changeVisibility(queueUrl, message, retryAfterSeconds);
      return { retryAfterSeconds };
    }

    if (messageId) {
      try {
        await this.recordDeadLetter.execute({
          consumerName: this.options.consumerName,
          messageId,
          payloadHash,
          receiveCount,
          errorCode,
        });
      } catch (auditError) {
        this.logger.warn('Could not record dead-lettered message in the inbox', describeError(auditError));
      }
    }
    this.metrics.sqsDeadLetteredMessage(reason);
    this.logger.error('Message moved to the DLQ', {
      reason,
      errorCode,
      receiveCount,
      sqsMessageId: message.MessageId,
      ...(error instanceof Error ? { errorMessage: error.message } : {}),
      alert: 'MESSAGE_DEAD_LETTERED',
    });
    await this.ack(queueUrl, message, 'DEAD_LETTERED');
    return 'acked';
  }

  private async ack(queueUrl: string, message: Message, result: string): Promise<void> {
    if (this.abandoned) return;
    try {
      await this.sqs.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
      );
      this.metrics.sqsMessageAcked(result);
    } catch (error) {
      // Already committed: the redelivery will be absorbed by the inbox.
      this.metrics.sqsDeleteFailed();
      this.logger.warn(
        'DeleteMessage failed after commit; redelivery will be deduplicated by the inbox',
        describeError(error),
      );
    }
  }

  private async changeVisibility(queueUrl: string, message: Message, seconds: number): Promise<void> {
    if (this.abandoned && seconds !== 0) return;
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: Math.max(0, Math.min(43_200, seconds)),
        }),
      );
    } catch (error) {
      this.logger.warn('ChangeMessageVisibility failed', describeError(error));
    }
  }

  /** Keeps a message invisible while it is still being processed. */
  private startHeartbeat(queueUrl: string, message: Message): () => Promise<void> {
    const periodMs = Math.max(1000, (this.options.visibilityTimeoutSeconds * 1000) / 2);
    let stopped = false;
    let pending = Promise.resolve();
    const timer = setInterval(() => {
      pending = pending.then(async () => {
        if (stopped) return;
        await this.changeVisibility(queueUrl, message, this.options.visibilityTimeoutSeconds);
        this.metrics.sqsVisibilityExtended();
      });
    }, periodMs);
    timer.unref?.();
    return async () => {
      stopped = true;
      clearInterval(timer);
      await pending;
    };
  }

  private async release(queueUrl: string, messages: Message[]): Promise<void> {
    // Once returned, an old receipt no longer belongs to this consumer. Late
    // completion must not alter visibility after a successor has received it.
    const owned = messages.filter((message) => this.inFlight.has(message));
    for (const message of owned) this.inFlight.delete(message);
    await Promise.all(owned.map((message) => this.changeVisibility(queueUrl, message, 0)));
  }

  private async postpone(queueUrl: string, messages: Message[], seconds: number): Promise<void> {
    if (this.abandoned) return this.release(queueUrl, messages);
    await Promise.all(messages.map((message) => this.changeVisibility(queueUrl, message, seconds)));
    for (const message of messages) this.inFlight.delete(message);
  }

  private retryDelaySeconds(attempt: number): number {
    return Math.ceil(this.backoff.delayAfterAttempt(attempt) / 1000);
  }

  /** Probes the database with exponential backoff (interruptible by stop) and resumes polling. */
  private async waitForDatabase(): Promise<void> {
    const probe = this.options.isDatabaseAvailable;
    for (let attempt = 1; this.running && probe; attempt += 1) {
      if (await probe().catch(() => false)) {
        this.databaseDown = false;
        this.metrics.setConsumerPaused(false);
        this.logger.info('Database available again: resuming consumption', {
          consumer: this.options.consumerName,
          probes: attempt,
        });
        return;
      }
      const delayMs = Math.min(DATABASE_PROBE_MAX_DELAY_MS, 500 * 2 ** Math.min(attempt - 1, 6));
      for (let waited = 0; waited < delayMs && this.running; waited += 250) {
        await sleep(250);
      }
    }
    this.databaseDown = false;
  }

  private async resolveQueueUrl(): Promise<string> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.queues.resolve(this.options.queueName);
      } catch (error) {
        if (!this.running) throw error;
        this.logger.warn('Queue not available yet', {
          queue: this.options.queueName,
          attempt,
          ...describeError(error),
        });
        await sleep(Math.min(1000 * attempt, 5000));
      }
    }
  }

  private async refreshDlqDepth(): Promise<void> {
    try {
      const dlqUrl = await this.queues.resolve(this.options.deadLetterQueueName);
      const response = await this.sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['ApproximateNumberOfMessages'] }),
      );
      this.metrics.setDlqDepth(
        this.options.deadLetterQueueName,
        Number(response.Attributes?.ApproximateNumberOfMessages ?? 0),
      );
    } catch {
      // metrics refresh is best-effort
    }
  }
}

/**
 * Correlation id that fits the schema (`varchar(128)`, safe charset): the
 * envelope's, else the message attribute, else the messageId, else a new one.
 * An oversized id must never make a valid message impossible to record.
 */
function correlationIdOf(envelope: WagerTransactionRequestedMessage, message: Message): string {
  const candidates = [
    envelope.correlationId,
    message.MessageAttributes?.correlationId?.StringValue,
    envelope.messageId,
  ];
  return (
    candidates.find((candidate) => candidate !== undefined && SAFE_CORRELATION_ID.test(candidate)) ??
    randomUUID()
  );
}

function receiveCountOf(message: Message): number {
  const value = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** Best effort: recover the envelope messageId of an invalid message for the inbox audit row. */
function extractMessageId(body: string | undefined): string | undefined {
  try {
    const parsed = JSON.parse(body ?? '') as { messageId?: unknown };
    return typeof parsed.messageId === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(parsed.messageId)
      ? parsed.messageId
      : undefined;
  } catch {
    return undefined;
  }
}

function safeHash(envelope: WagerTransactionRequestedMessage): string | undefined {
  try {
    const { idempotencyKey: _ignored, ...payload } = envelope.data;
    return wagerPayloadHash(payload);
  } catch {
    return undefined;
  }
}
