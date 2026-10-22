export enum WagerTransactionKind {
  /** Internal only: opening credit of a wallet. Never accepted from HTTP or SQS. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  /** Accepted, not yet applied. Only exists in memory during a database transaction. */
  Pending = 'PENDING',
  /** Waiting for the referenced transaction; re-attempted by the PendingReferenceWorker. */
  PendingReference = 'PENDING_REFERENCE',
  /** Applied (terminal). */
  Processed = 'PROCESSED',
  /** Business rule violation (terminal). Never moves money. */
  Rejected = 'REJECTED',
  /** Permanent processing failure (terminal, auditable). Never moves money. */
  Failed = 'FAILED',
}

/** Entry point that produced the transaction. OPENING is the only INTERNAL kind. */
export enum TransactionChannel {
  Http = 'HTTP',
  Sqs = 'SQS',
  Internal = 'INTERNAL',
}

/**
 * Stable, machine-readable failure taxonomy persisted with REJECTED/FAILED
 * transactions. Providers must branch on these codes, never on messages.
 * Adding a code is backwards compatible; renaming one is a breaking change.
 */
export enum FailureCode {
  /** BET larger than the available balance. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** ROLLBACK whose inverse debit would make the balance negative (distinct from a BET without funds). */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  /** Transaction currency differs from the wallet currency. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** playerId does not own the wallet. */
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  /** The referenced transaction never appeared within the retry limit / TTL. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referenced transaction belongs to a different player, wallet, currency or round. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Kind cannot reference the kind found (e.g. REFUND of a WIN). */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** Referenced transaction ended REJECTED/FAILED, so there is nothing to reverse or settle. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** The reference already has a successful REFUND or ROLLBACK (at most one reversal per transaction). */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** REFUND/ROLLBACK amount differs from the referenced amount (partial reversals are out of scope). */
  ReversalAmountMismatch = 'REVERSAL_AMOUNT_MISMATCH',
  /** Credit would exceed the supported balance precision (NUMERIC(20,2)). */
  BalanceLimitExceeded = 'BALANCE_LIMIT_EXCEEDED',
  /** FAILED: the pending reference could not be resolved due to repeated unexpected errors. */
  ReferenceResolutionFailed = 'REFERENCE_RESOLUTION_FAILED',
}

export const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Kinds that may be submitted by providers (HTTP or SQS). */
export const PROVIDER_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];
