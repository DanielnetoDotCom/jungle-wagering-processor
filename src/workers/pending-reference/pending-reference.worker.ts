import type { BacklogQueries } from '../../application/queries/backlog-queries';
import type { PendingReferenceClaim } from '../../application/ports/persistence.ports';
import type { Logger } from '../../application/ports/runtime.ports';
import type { ResolvePendingReferenceUseCase } from '../../application/use-cases/resolve-pending-reference.use-case';
import { describeError } from '../../infrastructure/logging/logger';
import { runWithLogContext } from '../../infrastructure/logging/log-context';
import type { PrometheusMetrics } from '../../infrastructure/metrics/prometheus-metrics';
import { PollingWorker, type PollingWorkerOptions } from '../polling-worker';

export interface PendingReferenceWorkerOptions extends PollingWorkerOptions {
  batchSize: number;
  leaseMs: number;
  concurrency: number;
}

/**
 * Re-attempts PENDING_REFERENCE transactions whose next_attempt_at is due.
 * Claim (short transaction, SKIP LOCKED + lease) and settlement (wallet lock
 * then transaction lock, status re-checked) are separate, so several
 * instances can run safely and a dead instance only delays work by one lease.
 */
export class PendingReferenceWorker extends PollingWorker {
  constructor(
    private readonly resolve: ResolvePendingReferenceUseCase,
    private readonly backlog: BacklogQueries,
    private readonly metrics: PrometheusMetrics,
    private readonly workerId: string,
    private readonly settings: PendingReferenceWorkerOptions,
    logger: Logger,
  ) {
    super(settings, logger);
  }

  protected async tick(): Promise<boolean> {
    const claims = await this.resolve.claimDue(this.workerId, {
      limit: this.settings.batchSize,
      leaseMs: this.settings.leaseMs,
    });
    if (claims.length === 0) {
      return false;
    }
    const queue = [...claims];
    const lanes = Array.from({ length: Math.min(this.settings.concurrency, queue.length) }, async () => {
      for (let claim = queue.shift(); claim; claim = queue.shift()) {
        await this.attempt(claim);
      }
    });
    await Promise.all(lanes);
    return true;
  }

  protected async maintain(): Promise<void> {
    this.metrics.setPendingReferenceBacklog(await this.backlog.pendingReferences());
  }

  private attempt(claim: PendingReferenceClaim): Promise<void> {
    return runWithLogContext(
      {
        transactionId: claim.transactionId,
        walletId: claim.walletId,
        correlationId: `reference-resolution:${claim.transactionId}`,
      },
      async () => {
        try {
          await this.resolve.execute(claim, this.workerId);
        } catch (error) {
          // Transient (e.g. database down): the lease expires and the row is claimed again later.
          this.logger.warn(
            'Pending reference attempt failed; will be retried after the lease',
            describeError(error),
          );
        }
      },
    );
  }
}
