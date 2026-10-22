import { InvariantViolationError, MoneyOverflowError } from '../errors/domain-errors';
import { LedgerDirection } from '../ledger/ledger-direction';
import type { WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import type { Wallet } from '../wallet/wallet';
import type { ReferenceRetryPolicy } from './reference-retry-policy';
import type { WagerTransaction } from './wager-transaction';
import { FailureCode, WagerTransactionStatus } from './wager-transaction-types';

export interface SettlementContext {
  /** Transaction found by (providerId, referenceExternalTransactionId), if any. */
  reference: WagerTransaction | undefined;
  /** Whether `reference` already has a PROCESSED REFUND or ROLLBACK. */
  referenceAlreadyReversed: boolean;
  /** Id reserved for the ledger line, used only if money moves. */
  ledgerEntryId: string;
  now: Date;
}

export type SettlementOutcome =
  | { type: 'PROCESSED'; ledgerEntry: WalletLedgerEntry | undefined; reference: WagerTransaction | undefined }
  | { type: 'REJECTED'; code: FailureCode }
  | { type: 'FAILED'; code: FailureCode }
  /** First time the transaction waits for its reference (emits WagerTransactionPendingReference). */
  | { type: 'PENDING_REFERENCE' }
  /** A worker attempt found the reference still unavailable; rescheduled, no new event. */
  | { type: 'REFERENCE_RETRY_SCHEDULED'; nextAttemptAt: Date };

/**
 * Applies the wagering rules to one transaction against its (locked) wallet.
 * Pure domain logic: the caller provides the reference lookup results and is
 * responsible for running this under the wallet's row lock and persisting the
 * mutated aggregates atomically. HTTP, SQS and the PendingReferenceWorker all
 * go through this single method.
 */
export class WagerSettlementService {
  constructor(private readonly referenceRetryPolicy: ReferenceRetryPolicy) {}

  settle(transaction: WagerTransaction, wallet: Wallet, context: SettlementContext): SettlementOutcome {
    if (transaction.walletId !== wallet.id) {
      throw new InvariantViolationError('Transaction and wallet do not match');
    }
    if (transaction.isTerminal()) {
      throw new InvariantViolationError(`Transaction ${transaction.id} is already ${transaction.status}`);
    }
    const isWorkerAttempt = transaction.status === WagerTransactionStatus.PendingReference;
    if (isWorkerAttempt) {
      transaction.registerReferenceAttempt(context.now);
    }

    if (!wallet.belongsTo(transaction.playerId)) {
      return this.reject(transaction, wallet, FailureCode.PlayerWalletMismatch, context.now);
    }
    if (transaction.money.currency !== wallet.currency) {
      return this.reject(transaction, wallet, FailureCode.CurrencyMismatch, context.now);
    }

    let reference: WagerTransaction | undefined;
    if (transaction.hasReference()) {
      const candidate = context.reference;
      if (!candidate || !candidate.isTerminal()) {
        return this.awaitReference(transaction, wallet, context.now);
      }
      const rejection = this.validateReference(transaction, candidate, context.referenceAlreadyReversed);
      if (rejection) {
        return this.reject(transaction, wallet, rejection, context.now);
      }
      reference = candidate;
    }

    if (!transaction.affectsBalance()) {
      transaction.markProcessed({
        referenceTransactionId: reference?.id,
        at: context.now,
        result: wallet.snapshot(),
      });
      return { type: 'PROCESSED', ledgerEntry: undefined, reference };
    }

    const movement = {
      money: transaction.money,
      transactionId: transaction.id,
      ledgerEntryId: context.ledgerEntryId,
      at: context.now,
    };
    let ledgerEntry: WalletLedgerEntry;
    if (transaction.ledgerDirectionFor(reference) === LedgerDirection.Debit) {
      if (!wallet.canDebit(transaction.money)) {
        const code = transaction.isReversal()
          ? FailureCode.ReversalInsufficientFunds
          : FailureCode.InsufficientFunds;
        return this.reject(transaction, wallet, code, context.now);
      }
      ledgerEntry = wallet.debit(movement);
    } else {
      try {
        ledgerEntry = wallet.credit(movement);
      } catch (error) {
        if (error instanceof MoneyOverflowError) {
          return this.reject(transaction, wallet, FailureCode.BalanceLimitExceeded, context.now);
        }
        throw error;
      }
    }

    transaction.markProcessed({
      referenceTransactionId: reference?.id,
      at: context.now,
      result: wallet.snapshot(),
    });
    return { type: 'PROCESSED', ledgerEntry, reference };
  }

  /**
   * A worker attempt crashed with an unexpected (non-transient) error. Counts
   * the attempt and, once the policy is exhausted, ends the transaction as
   * FAILED so it stays auditable instead of being retried forever.
   */
  recordResolutionFailure(transaction: WagerTransaction, wallet: Wallet, now: Date): SettlementOutcome {
    transaction.registerReferenceAttempt(now);
    if (this.isExhausted(transaction, now)) {
      transaction.fail(FailureCode.ReferenceResolutionFailed, { at: now, result: wallet.snapshot() });
      return { type: 'FAILED', code: FailureCode.ReferenceResolutionFailed };
    }
    const nextAttemptAt = this.referenceRetryPolicy.nextAttemptAt(transaction.referenceAttempts, now);
    transaction.scheduleReferenceRetry({ at: now, nextAttemptAt });
    return { type: 'REFERENCE_RETRY_SCHEDULED', nextAttemptAt };
  }

  private validateReference(
    transaction: WagerTransaction,
    reference: WagerTransaction,
    alreadyReversed: boolean,
  ): FailureCode | undefined {
    if (reference.status !== WagerTransactionStatus.Processed) {
      return FailureCode.ReferenceNotProcessed;
    }
    if (transaction.referenceMismatches(reference).length > 0) {
      return FailureCode.ReferenceMismatch;
    }
    if (!transaction.canReference(reference.kind)) {
      return FailureCode.ReferenceKindNotAllowed;
    }
    if (transaction.isReversal()) {
      if (!transaction.money.equals(reference.money)) {
        return FailureCode.ReversalAmountMismatch;
      }
      // Conservative rule: at most ONE successful reversal (REFUND or ROLLBACK)
      // per referenced transaction, whatever the reversal kind.
      if (alreadyReversed) {
        return FailureCode.ReferenceAlreadyReversed;
      }
    }
    return undefined;
  }

  private awaitReference(transaction: WagerTransaction, wallet: Wallet, now: Date): SettlementOutcome {
    if (transaction.status === WagerTransactionStatus.Pending) {
      transaction.markPendingReference({
        at: now,
        nextAttemptAt: this.referenceRetryPolicy.firstAttemptAt(now),
        expiresAt: this.referenceRetryPolicy.expiresAt(transaction.createdAt),
        result: wallet.snapshot(),
      });
      return { type: 'PENDING_REFERENCE' };
    }
    if (this.isExhausted(transaction, now)) {
      return this.reject(transaction, wallet, FailureCode.ReferenceNotFound, now);
    }
    const nextAttemptAt = this.referenceRetryPolicy.nextAttemptAt(transaction.referenceAttempts, now);
    transaction.scheduleReferenceRetry({ at: now, nextAttemptAt });
    return { type: 'REFERENCE_RETRY_SCHEDULED', nextAttemptAt };
  }

  private isExhausted(transaction: WagerTransaction, now: Date): boolean {
    const expiresAt =
      transaction.referenceExpiresAt ?? this.referenceRetryPolicy.expiresAt(transaction.createdAt);
    return this.referenceRetryPolicy.isExhausted(transaction.referenceAttempts, now, expiresAt);
  }

  private reject(
    transaction: WagerTransaction,
    wallet: Wallet,
    code: FailureCode,
    now: Date,
  ): SettlementOutcome {
    transaction.reject(code, { at: now, result: wallet.snapshot() });
    return { type: 'REJECTED', code };
  }
}
