import { InvariantViolationError } from '../../domain/errors/domain-errors';
import type { SettlementOutcome } from '../../domain/wagering/wager-settlement.service';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-types';
import { ApplicationError, ErrorCategory } from '../errors/application-errors';
import type { WageringMetrics } from '../ports/metrics.port';
import type { PendingReferenceClaim, UnitOfWork } from '../ports/persistence.ports';
import type { Clock, FaultInjector, Logger } from '../ports/runtime.ports';
import type { SettlementRecorder } from '../services/settlement-recorder';
import type { TransactionRetryExecutor } from '../services/transaction-retry';

export type ResolutionResult =
  | { type: 'ATTEMPTED'; outcome: SettlementOutcome['type']; status: WagerTransactionStatus }
  /** Another worker (or the HTTP path waking dependents) already settled or rescheduled it. */
  | { type: 'SKIPPED'; reason: 'NOT_PENDING' | 'NOT_DUE' | 'NOT_FOUND' };

/**
 * One worker attempt on a PENDING_REFERENCE transaction. Uses the same lock
 * order as the main write path (wallet row first, then the transaction row)
 * and the same SettlementRecorder, so validations and financial rules are
 * identical to a first-time submission. Safe under concurrent workers: the
 * status is re-checked after both locks are held.
 */
export class ResolvePendingReferenceUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly recorder: SettlementRecorder,
    private readonly retry: TransactionRetryExecutor,
    private readonly clock: Clock,
    private readonly metrics: WageringMetrics,
    private readonly logger: Logger,
    private readonly faults: FaultInjector,
  ) {}

  /** Short transaction: claims due rows (SKIP LOCKED + lease) and commits before any settlement. */
  claimDue(workerId: string, options: { limit: number; leaseMs: number }): Promise<PendingReferenceClaim[]> {
    const now = this.clock.now();
    return this.uow.run((scope) =>
      scope.transactions.claimDuePendingReferences({
        now,
        workerId,
        leaseUntil: new Date(now.getTime() + options.leaseMs),
        limit: options.limit,
      }),
    );
  }

  async execute(claim: PendingReferenceClaim, workerId: string): Promise<ResolutionResult> {
    try {
      const result = await this.retry.run('resolve-reference', () => this.attempt(claim, workerId, 'settle'));
      this.metrics.pendingReferenceAttempt(result.type === 'ATTEMPTED' ? result.outcome : result.reason);
      return result;
    } catch (error) {
      if (error instanceof ApplicationError && error.category === ErrorCategory.Transient) {
        // Database trouble: leave the claim to expire, another attempt will follow.
        throw error;
      }
      this.logger.error('Unexpected error resolving pending reference; counting the attempt', {
        transactionId: claim.transactionId,
        walletId: claim.walletId,
        error: describe(error),
      });
      const result = await this.retry.run('resolve-reference-failure', () =>
        this.attempt(claim, workerId, 'failure'),
      );
      this.metrics.pendingReferenceAttempt(result.type === 'ATTEMPTED' ? result.outcome : result.reason);
      return result;
    }
  }

  private attempt(
    claim: PendingReferenceClaim,
    workerId: string,
    mode: 'settle' | 'failure',
  ): Promise<ResolutionResult> {
    return this.uow.run(async (scope) => {
      const lock = await scope.wallets.lockById(claim.walletId);
      this.metrics.walletLockAcquired(lock.waitSeconds, lock.contended);
      const now = this.clock.now(); // after the lock, like the main write path
      if (!lock.wallet) {
        throw new InvariantViolationError(`Wallet ${claim.walletId} of a pending transaction does not exist`);
      }
      const transaction = await scope.transactions.lockById(claim.transactionId);
      if (!transaction) {
        return { type: 'SKIPPED', reason: 'NOT_FOUND' } as const;
      }
      if (transaction.walletId !== lock.wallet.id) {
        throw new InvariantViolationError('Claimed transaction belongs to a different wallet');
      }
      if (transaction.status !== WagerTransactionStatus.PendingReference) {
        return { type: 'SKIPPED', reason: 'NOT_PENDING' } as const;
      }
      if (
        mode === 'settle' &&
        transaction.nextAttemptAt &&
        transaction.nextAttemptAt.getTime() > now.getTime()
      ) {
        return { type: 'SKIPPED', reason: 'NOT_DUE' } as const;
      }

      const trace = {
        now,
        correlationId: `reference-resolution:${transaction.id}`,
        causationId: `${workerId}:attempt-${transaction.referenceAttempts + 1}`,
      };
      const outcome =
        mode === 'settle'
          ? await this.recorder.settle(scope, transaction, lock.wallet, trace)
          : await this.recorder.recordResolutionFailure(scope, transaction, lock.wallet, trace);

      await scope.flush();
      await this.faults.checkpoint('reference.before-commit');
      this.logger.info('Pending reference attempt', {
        transactionId: transaction.id,
        walletId: transaction.walletId,
        providerId: transaction.providerId,
        outcome: outcome.type,
        status: transaction.status,
        attempts: transaction.referenceAttempts,
        failureCode: transaction.failureCode,
      });
      return { type: 'ATTEMPTED', outcome: outcome.type, status: transaction.status } as const;
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
