import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { RetryReason, WageringMetrics } from '../../application/ports/metrics.port';
import type { OutboxBacklog } from '../../application/ports/persistence.ports';
import type { TransactionChannel, WagerTransactionKind } from '../../domain/wagering/wager-transaction-types';

const LATENCY_BUCKETS = [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const LAG_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300];

/**
 * Prometheus metrics of one process. Uses its own Registry (not the global
 * one) so several instances can coexist in tests. All names are prefixed with
 * `wagering_`; default labels identify service and instance.
 */
export class PrometheusMetrics implements WageringMetrics {
  readonly registry = new Registry();

  private readonly transactions = this.counter(
    'wagering_transactions_total',
    'Wager transactions recorded per kind/status/channel',
    ['kind', 'status', 'channel'],
  );
  private readonly replays = this.counter(
    'wagering_idempotent_replays_total',
    'Requests answered from a stored result',
    ['channel'],
  );
  private readonly conflicts = this.counter(
    'wagering_idempotency_conflicts_total',
    'Idempotency key / external id reused with another payload',
    ['code', 'channel'],
  );
  private readonly duplicates = this.counter(
    'wagering_inbox_duplicates_total',
    'Messages already processed according to the inbox',
    ['consumer'],
  );
  private readonly retries = this.counter(
    'wagering_db_retries_total',
    'Units of work retried after a transient conflict',
    ['operation', 'reason'],
  );
  private readonly lockWait = this.histogram(
    'wagering_wallet_lock_wait_seconds',
    'Time spent acquiring the wallet row lock',
    ['contended'],
    LATENCY_BUCKETS,
  );
  private readonly lockContention = this.counter(
    'wagering_wallet_lock_contention_total',
    'Wallet lock acquisitions that had to wait for another transaction',
    [],
  );
  private readonly lockTimeouts = this.counter(
    'wagering_lock_timeouts_total',
    'lock_timeout exceeded while waiting for a wallet',
    ['operation'],
  );
  private readonly deadlocks = this.counter('wagering_deadlocks_total', 'Deadlocks detected by PostgreSQL', [
    'operation',
  ]);
  private readonly processing = this.histogram(
    'wagering_processing_duration_seconds',
    'End-to-end use case latency',
    ['operation', 'outcome'],
    LATENCY_BUCKETS,
  );
  private readonly reconciliations = this.counter(
    'wagering_reconciliations_total',
    'Reconciliation runs by result',
    ['result'],
  );
  private readonly inconsistencies = this.counter(
    'wagering_reconciliation_inconsistencies_total',
    'Wallets whose ledger does not match the stored balance',
    [],
  );
  private readonly referenceAttempts = this.counter(
    'wagering_pending_reference_attempts_total',
    'PendingReferenceWorker attempts by outcome',
    ['outcome'],
  );
  private readonly outboxPublishedTotal = this.counter(
    'wagering_outbox_published_total',
    'Events published to SQS',
    [],
  );
  private readonly outboxFailures = this.counter(
    'wagering_outbox_publish_failures_total',
    'Failed publication attempts',
    [],
  );
  private readonly outboxDead = this.counter(
    'wagering_outbox_dead_total',
    'Events retained as DEAD after exhausting retries',
    [],
  );
  private readonly outboxDelay = this.histogram(
    'wagering_outbox_publish_delay_seconds',
    'Commit-to-publish delay of events',
    [],
    LAG_BUCKETS,
  );
  private readonly outboxPending = this.gauge('wagering_outbox_pending', 'PENDING events in the outbox', []);
  private readonly outboxDeadGauge = this.gauge(
    'wagering_outbox_dead',
    'DEAD events awaiting operational intervention',
    [],
  );
  private readonly outboxLag = this.gauge(
    'wagering_outbox_lag_seconds',
    'Age of the oldest PENDING outbox event',
    [],
  );
  private readonly referencePending = this.gauge(
    'wagering_pending_reference_transactions',
    'Transactions in PENDING_REFERENCE',
    [],
  );
  private readonly referenceDue = this.gauge(
    'wagering_pending_reference_due',
    'PENDING_REFERENCE transactions due for an attempt',
    [],
  );
  private readonly referenceLag = this.gauge(
    'wagering_pending_reference_lag_seconds',
    'How overdue the oldest due PENDING_REFERENCE transaction is',
    [],
  );
  private readonly httpRequests = this.counter('wagering_http_requests_total', 'HTTP requests', [
    'method',
    'route',
    'status',
  ]);
  private readonly httpDuration = this.histogram(
    'wagering_http_request_duration_seconds',
    'HTTP latency',
    ['method', 'route'],
    LATENCY_BUCKETS,
  );
  private readonly sqsReceived = this.counter(
    'wagering_sqs_messages_received_total',
    'Messages received from the transactions queue',
    [],
  );
  private readonly sqsAcked = this.counter(
    'wagering_sqs_messages_acked_total',
    'Messages deleted after commit',
    ['result'],
  );
  private readonly sqsRetries = this.counter(
    'wagering_sqs_message_retries_total',
    'Messages returned to the queue with backoff',
    ['reason'],
  );
  private readonly sqsDeadLettered = this.counter(
    'wagering_sqs_messages_dead_lettered_total',
    'Messages explicitly moved to the DLQ',
    ['reason'],
  );
  private readonly sqsDeleteFailures = this.counter(
    'wagering_sqs_delete_failures_total',
    'DeleteMessage failures (message will be redelivered)',
    [],
  );
  private readonly sqsVisibilityExtensions = this.counter(
    'wagering_sqs_visibility_extensions_total',
    'Visibility timeout extensions during long processing',
    [],
  );
  private readonly sqsDlqDepth = this.gauge(
    'wagering_sqs_dlq_depth',
    'Approximate number of messages in the DLQ',
    ['queue'],
  );
  private readonly consumerPaused = this.gauge(
    'wagering_sqs_consumer_paused',
    '1 while the consumer waits for the database to come back (no messages consumed)',
    [],
  );
  private readonly up = this.gauge(
    'wagering_process_start_time_seconds',
    'Process start time (unix seconds)',
    [],
  );
  private readonly rss = new Gauge({
    name: 'wagering_process_resident_memory_bytes',
    help: 'Resident set size',
    registers: [this.registry],
    collect() {
      this.set(process.memoryUsage().rss);
    },
  });

  constructor(defaultLabels: { service: string; instance: string }) {
    this.registry.setDefaultLabels(defaultLabels);
    this.up.set(Math.floor(Date.now() / 1000));
    void this.rss;
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  // ---- WageringMetrics (application port) --------------------------------

  transactionRecorded(kind: WagerTransactionKind, status: string, channel: TransactionChannel): void {
    this.transactions.inc({ kind, status, channel });
  }

  idempotentReplay(channel: TransactionChannel): void {
    this.replays.inc({ channel });
  }

  idempotencyConflict(code: string, channel: TransactionChannel): void {
    this.conflicts.inc({ code, channel });
  }

  duplicateMessage(consumerName: string): void {
    this.duplicates.inc({ consumer: consumerName });
  }

  transactionRetry(operation: string, reason: RetryReason): void {
    this.retries.inc({ operation, reason });
  }

  walletLockAcquired(waitSeconds: number, contended: boolean): void {
    this.lockWait.observe({ contended: String(contended) }, waitSeconds);
    if (contended) this.lockContention.inc();
  }

  lockTimeout(operation: string): void {
    this.lockTimeouts.inc({ operation });
  }

  deadlock(operation: string): void {
    this.deadlocks.inc({ operation });
  }

  processingDuration(operation: string, outcome: string, seconds: number): void {
    this.processing.observe({ operation, outcome }, seconds);
  }

  reconciliationChecked(consistent: boolean): void {
    this.reconciliations.inc({ result: consistent ? 'consistent' : 'inconsistent' });
    if (!consistent) this.inconsistencies.inc();
  }

  pendingReferenceAttempt(outcome: string): void {
    this.referenceAttempts.inc({ outcome });
  }

  outboxPublished(count: number, delaysSeconds: readonly number[]): void {
    this.outboxPublishedTotal.inc(count);
    for (const delay of delaysSeconds) this.outboxDelay.observe(Math.max(0, delay));
  }

  outboxPublishFailed(count: number): void {
    this.outboxFailures.inc(count);
  }

  outboxDeadLettered(count: number): void {
    this.outboxDead.inc(count);
  }

  // ---- adapter-level metrics ---------------------------------------------

  setOutboxBacklog(backlog: OutboxBacklog): void {
    this.outboxPending.set(backlog.pending);
    this.outboxDeadGauge.set(backlog.dead);
    this.outboxLag.set(backlog.oldestPendingSeconds);
  }

  setPendingReferenceBacklog(backlog: { pending: number; due: number; oldestDueSeconds: number }): void {
    this.referencePending.set(backlog.pending);
    this.referenceDue.set(backlog.due);
    this.referenceLag.set(backlog.oldestDueSeconds);
  }

  httpRequest(method: string, route: string, status: number, seconds: number): void {
    this.httpRequests.inc({ method, route, status: String(status) });
    this.httpDuration.observe({ method, route }, seconds);
  }

  sqsMessagesReceived(count: number): void {
    this.sqsReceived.inc(count);
  }

  sqsMessageAcked(result: string): void {
    this.sqsAcked.inc({ result });
  }

  sqsRetryScheduled(reason: string): void {
    this.sqsRetries.inc({ reason });
  }

  sqsDeadLetteredMessage(reason: string): void {
    this.sqsDeadLettered.inc({ reason });
  }

  sqsDeleteFailed(): void {
    this.sqsDeleteFailures.inc();
  }

  sqsVisibilityExtended(): void {
    this.sqsVisibilityExtensions.inc();
  }

  setDlqDepth(queue: string, depth: number): void {
    this.sqsDlqDepth.set({ queue }, depth);
  }

  setConsumerPaused(paused: boolean): void {
    this.consumerPaused.set(paused ? 1 : 0);
  }

  private counter<L extends string>(name: string, help: string, labelNames: readonly L[]): Counter<L> {
    return new Counter({ name, help, labelNames, registers: [this.registry] });
  }

  private gauge<L extends string>(name: string, help: string, labelNames: readonly L[]): Gauge<L> {
    return new Gauge({ name, help, labelNames, registers: [this.registry] });
  }

  private histogram<L extends string>(
    name: string,
    help: string,
    labelNames: readonly L[],
    buckets: number[],
  ): Histogram<L> {
    return new Histogram({ name, help, labelNames, buckets, registers: [this.registry] });
  }
}
