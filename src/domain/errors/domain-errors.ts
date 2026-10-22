/**
 * Domain errors signal programming mistakes or invalid input that the domain
 * refuses to model. Expected business outcomes (insufficient funds, missing
 * reference, ...) are NOT exceptions: they are recorded as REJECTED /
 * PENDING_REFERENCE transactions carrying a stable FailureCode.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Malformed or out-of-contract input (e.g. "1e3", "10.001", missing reference). */
export class DomainValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR';

  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';

  constructor(message: string) {
    super(message);
  }
}

export class UnsupportedCurrencyError extends DomainError {
  readonly code = 'UNSUPPORTED_CURRENCY';

  constructor(currency: string) {
    super(`Currency "${currency}" is not a supported ISO-4217 currency with 2 minor units`);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected ${expected}, received ${actual}`);
  }
}

export class MoneyOverflowError extends DomainError {
  readonly code = 'MONEY_OVERFLOW';

  constructor() {
    super('Monetary value exceeds the supported precision (18 integer digits, 2 decimal places)');
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(walletId: string) {
    super(`Wallet ${walletId} does not have enough balance for this debit`);
  }
}

/** A state transition was attempted from a state that does not allow it (e.g. a terminal one). */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(message: string) {
    super(message);
  }
}

/** An internal invariant does not hold. Always a bug or corrupted state, never user input. */
export class InvariantViolationError extends DomainError {
  readonly code = 'INVARIANT_VIOLATION';

  constructor(message: string) {
    super(message);
  }
}
