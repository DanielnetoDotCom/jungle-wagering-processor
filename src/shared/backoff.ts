export interface BackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  /** 0 = deterministic; 1 = "full jitter" (uniform in [0, delay]). */
  jitterRatio: number;
}

/** Retry schedule: how many attempts are allowed and how long to wait after each one. */
export interface RetrySchedule {
  readonly maxAttempts: number;
  delayAfterAttempt(attempt: number): number;
}

/**
 * Exponential backoff with bounded jitter:
 *   delay(n) = min(max, base * 2^(n-1)) * (1 - jitter * random)
 * Jitter spreads retries of many competing workers; `random` is injectable to
 * make schedules deterministic in tests.
 */
export class ExponentialBackoff implements RetrySchedule {
  constructor(
    private readonly options: BackoffOptions & { maxAttempts: number },
    private readonly random: () => number = Math.random,
  ) {}

  get maxAttempts(): number {
    return this.options.maxAttempts;
  }

  delayAfterAttempt(attempt: number): number {
    const exponent = Math.max(0, attempt - 1);
    const ceiling = Math.min(this.options.maxDelayMs, this.options.baseDelayMs * 2 ** exponent);
    const jitter = Math.min(1, Math.max(0, this.options.jitterRatio));
    return Math.max(0, Math.round(ceiling * (1 - jitter * this.random())));
  }
}
