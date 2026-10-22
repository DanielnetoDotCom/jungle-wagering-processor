import { DomainValidationError } from '../errors/domain-errors';

export interface ReferenceRetryPolicyProps {
  /** Delay before the first worker attempt. */
  initialDelayMs: number;
  /** Upper bound for a single delay. */
  maxDelayMs: number;
  /** Exponential growth factor. */
  multiplier: number;
  /** Worker attempts before giving up. */
  maxAttempts: number;
  /** Absolute lifetime of a pending reference, counted from acceptance. */
  ttlMs: number;
}

/**
 * Deterministic exponential backoff for PENDING_REFERENCE transactions. No
 * jitter on purpose: retries are scheduled in the database (next_attempt_at)
 * and claimed with SKIP LOCKED, so there is no thundering herd to spread, and
 * determinism keeps the schedule testable with an injected clock.
 * Exhaustion happens at whichever comes first: maxAttempts or TTL.
 */
export class ReferenceRetryPolicy {
  private constructor(private readonly props: ReferenceRetryPolicyProps) {}

  static create(props: ReferenceRetryPolicyProps): ReferenceRetryPolicy {
    const positive = [props.initialDelayMs, props.maxDelayMs, props.maxAttempts, props.ttlMs];
    if (positive.some((value) => !Number.isFinite(value) || value <= 0) || props.multiplier < 1) {
      throw new DomainValidationError('Invalid reference retry policy');
    }
    if (props.maxDelayMs < props.initialDelayMs) {
      throw new DomainValidationError('maxDelayMs must be >= initialDelayMs');
    }
    return new ReferenceRetryPolicy({ ...props });
  }

  get maxAttempts(): number {
    return this.props.maxAttempts;
  }

  /** Delay after `attemptsMade` failed worker attempts (0 => initial delay). */
  delayAfter(attemptsMade: number): number {
    const raw = this.props.initialDelayMs * Math.pow(this.props.multiplier, attemptsMade);
    return Math.min(raw, this.props.maxDelayMs);
  }

  firstAttemptAt(acceptedAt: Date): Date {
    return new Date(acceptedAt.getTime() + this.delayAfter(0));
  }

  expiresAt(acceptedAt: Date): Date {
    return new Date(acceptedAt.getTime() + this.props.ttlMs);
  }

  nextAttemptAt(attemptsMade: number, now: Date): Date {
    return new Date(now.getTime() + this.delayAfter(attemptsMade));
  }

  isExhausted(attemptsMade: number, now: Date, expiresAt: Date): boolean {
    return attemptsMade >= this.props.maxAttempts || now.getTime() >= expiresAt.getTime();
  }
}
