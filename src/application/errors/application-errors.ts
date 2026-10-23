import type { RetryReason } from '../ports/metrics.port';

/**
 * Error categories drive the HTTP status and the SQS ack/retry decision, so
 * clients and consumers never need to parse human-readable messages.
 */
export enum ErrorCategory {
  Validation = 'VALIDATION',
  Forbidden = 'FORBIDDEN',
  NotFound = 'NOT_FOUND',
  Conflict = 'CONFLICT',
  BusinessRule = 'BUSINESS_RULE',
  Transient = 'TRANSIENT',
  Internal = 'INTERNAL',
}

export abstract class ApplicationError extends Error {
  abstract readonly code: string;
  abstract readonly category: ErrorCategory;

  protected constructor(
    message: string,
    /** Safe, structured context that may be returned to the caller. */
    readonly details?: Readonly<Record<string, unknown>>,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
  }

  get retryable(): boolean {
    return this.category === ErrorCategory.Transient;
  }
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export class RequestValidationError extends ApplicationError {
  readonly code = 'VALIDATION_ERROR';
  readonly category = ErrorCategory.Validation;

  constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message, { issues });
  }
}

export class ResourceNotFoundError extends ApplicationError {
  readonly category = ErrorCategory.NotFound;

  constructor(
    readonly code: 'WALLET_NOT_FOUND' | 'TRANSACTION_NOT_FOUND',
    message: string,
  ) {
    super(message);
  }
}

export type ConflictCode =
  'WALLET_ALREADY_EXISTS' | 'IDEMPOTENCY_KEY_CONFLICT' | 'DUPLICATE_EXTERNAL_TRANSACTION';

export class ConflictError extends ApplicationError {
  readonly category = ErrorCategory.Conflict;

  constructor(
    readonly code: ConflictCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message, details);
  }
}

export type TransientCode =
  'DATABASE_UNAVAILABLE' | 'LOCK_TIMEOUT' | 'CONCURRENCY_CONFLICT' | 'STATEMENT_TIMEOUT';

/** Temporary infrastructure condition: safe to retry (idempotency makes the retry harmless). */
export class TransientInfrastructureError extends ApplicationError {
  readonly category = ErrorCategory.Transient;

  constructor(
    readonly code: TransientCode,
    message: string,
    /** Set when an in-process retry of the whole unit of work is safe and useful. */
    readonly retryReason?: RetryReason,
    cause?: unknown,
  ) {
    super(message, undefined, cause);
  }
}

/** A unique constraint lost a race: re-running the unit of work re-evaluates idempotency. */
export class UniqueConstraintRaceError extends TransientInfrastructureError {
  constructor(
    readonly constraint: string | undefined,
    cause?: unknown,
  ) {
    super(
      'CONCURRENCY_CONFLICT',
      `Concurrent write detected on ${constraint ?? 'a unique constraint'}`,
      'unique_race',
      cause,
    );
  }
}

/**
 * A database integrity rule (CHECK, FK, trigger) rejected a write the
 * application believed valid. Indicates a bug or tampering; never retried.
 */
export class IntegrityViolationError extends ApplicationError {
  readonly code = 'INTEGRITY_VIOLATION';
  readonly category = ErrorCategory.Internal;

  constructor(
    readonly constraint: string | undefined,
    message: string,
    cause?: unknown,
  ) {
    super(message, undefined, cause);
  }
}

/**
 * Any other database error. Its message names only the SQLSTATE: driver
 * messages quote SQL bindings and row values (player ids, amounts, keys),
 * which must never reach the logs. The original error stays in `cause`.
 */
export class UnexpectedDatabaseError extends ApplicationError {
  readonly code = 'DATABASE_ERROR';
  readonly category = ErrorCategory.Internal;

  constructor(
    readonly sqlState: string,
    cause?: unknown,
  ) {
    super(`Database error (SQLSTATE ${sqlState})`, undefined, cause);
  }
}
