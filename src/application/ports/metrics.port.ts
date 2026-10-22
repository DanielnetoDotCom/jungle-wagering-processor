import type { TransactionChannel, WagerTransactionKind } from '../../domain/wagering/wager-transaction-types';

export type RetryReason = 'deadlock' | 'serialization' | 'lock_timeout' | 'unique_race';

/** Application-level measurements. The Prometheus adapter implements it. */
export interface WageringMetrics {
  transactionRecorded(kind: WagerTransactionKind, status: string, channel: TransactionChannel): void;
  idempotentReplay(channel: TransactionChannel): void;
  idempotencyConflict(code: string, channel: TransactionChannel): void;
  duplicateMessage(consumerName: string): void;
  transactionRetry(operation: string, reason: RetryReason): void;
  walletLockAcquired(waitSeconds: number, contended: boolean): void;
  lockTimeout(operation: string): void;
  deadlock(operation: string): void;
  processingDuration(operation: string, outcome: string, seconds: number): void;
  reconciliationChecked(consistent: boolean): void;
  pendingReferenceAttempt(outcome: string): void;
  outboxPublished(count: number, delaysSeconds: readonly number[]): void;
  outboxPublishFailed(count: number): void;
  outboxDeadLettered(count: number): void;
}

export const NOOP_METRICS: WageringMetrics = {
  transactionRecorded: () => undefined,
  idempotentReplay: () => undefined,
  idempotencyConflict: () => undefined,
  duplicateMessage: () => undefined,
  transactionRetry: () => undefined,
  walletLockAcquired: () => undefined,
  lockTimeout: () => undefined,
  deadlock: () => undefined,
  processingDuration: () => undefined,
  reconciliationChecked: () => undefined,
  pendingReferenceAttempt: () => undefined,
  outboxPublished: () => undefined,
  outboxPublishFailed: () => undefined,
  outboxDeadLettered: () => undefined,
};
