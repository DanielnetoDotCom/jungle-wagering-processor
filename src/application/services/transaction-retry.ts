import { ExponentialBackoff } from '../../shared/backoff';
import { sleep } from '../../shared/sleep';
import { TransientInfrastructureError } from '../errors/application-errors';
import type { WageringMetrics } from '../ports/metrics.port';
import type { Logger } from '../ports/runtime.ports';

export interface TransactionRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Re-runs a WHOLE unit of work after a transient database conflict
 * (deadlock, serialization failure, lock timeout, lost unique race). The
 * previous SQL transaction was rolled back by PostgreSQL, and the new attempt
 * starts again from the idempotency check, so a retry can never apply an
 * operation twice. Connection failures are not retried here: they surface as
 * 503 / SQS redelivery instead of piling up behind a dead database.
 */
export class TransactionRetryExecutor {
  private readonly backoff: ExponentialBackoff;

  constructor(
    private readonly options: TransactionRetryOptions,
    private readonly metrics: WageringMetrics,
    private readonly logger: Logger,
    random: () => number = Math.random,
  ) {
    this.backoff = new ExponentialBackoff(
      {
        baseDelayMs: options.baseDelayMs,
        maxDelayMs: options.maxDelayMs,
        jitterRatio: 0.5,
        maxAttempts: options.maxAttempts,
      },
      random,
    );
  }

  async run<T>(operation: string, work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        const reason = error instanceof TransientInfrastructureError ? error.retryReason : undefined;
        if (reason === 'deadlock') this.metrics.deadlock(operation);
        if (reason === 'lock_timeout') this.metrics.lockTimeout(operation);
        if (reason === undefined || attempt >= this.options.maxAttempts) {
          throw error;
        }
        this.metrics.transactionRetry(operation, reason);
        const delayMs = this.backoff.delayAfterAttempt(attempt);
        this.logger.warn('Retrying unit of work after transient conflict', {
          operation,
          reason,
          attempt,
          delayMs,
        });
        await sleep(delayMs);
      }
    }
  }
}
