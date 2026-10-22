import type { BacklogQueries } from '../../application/queries/backlog-queries';
import type { Logger } from '../../application/ports/runtime.ports';
import type { PublishOutboxBatchUseCase } from '../../application/use-cases/publish-outbox-batch.use-case';
import type { PrometheusMetrics } from '../../infrastructure/metrics/prometheus-metrics';
import { PollingWorker, type PollingWorkerOptions } from '../polling-worker';

/**
 * Publishes committed outbox events. Any number of instances can run: claims
 * use FOR UPDATE SKIP LOCKED plus a persistent lease, so each event is owned
 * by one publisher at a time and recovered when a publisher dies.
 */
export class OutboxPublisherWorker extends PollingWorker {
  constructor(
    private readonly publish: PublishOutboxBatchUseCase,
    private readonly backlog: BacklogQueries,
    private readonly metrics: PrometheusMetrics,
    private readonly workerId: string,
    options: PollingWorkerOptions,
    logger: Logger,
  ) {
    super(options, logger);
  }

  protected async tick(): Promise<boolean> {
    const result = await this.publish.execute(this.workerId);
    if (result.claimed > 0) {
      this.logger.debug('Outbox batch processed', { ...result, workerId: this.workerId });
    }
    return result.claimed > 0;
  }

  protected async maintain(): Promise<void> {
    this.metrics.setOutboxBacklog(await this.backlog.outbox());
  }
}
