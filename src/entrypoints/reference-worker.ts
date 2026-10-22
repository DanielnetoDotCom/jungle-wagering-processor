import 'reflect-metadata';
import { BacklogQueries } from '../application/queries/backlog-queries';
import { createCore } from '../bootstrap/core';
import { createNestApp } from '../bootstrap/nest/create-app';
import { WorkerModule } from '../bootstrap/nest/modules';
import { runProcess } from '../bootstrap/process-runner';
import { PendingReferenceWorker } from '../workers/pending-reference/pending-reference.worker';

/** Re-attempts PENDING_REFERENCE transactions (safe with several instances). */
void runProcess('reference-worker', async (config) => {
  const core = await createCore(config);
  const worker = new PendingReferenceWorker(
    core.resolvePendingReference,
    new BacklogQueries(core.uow, core.clock),
    core.metrics,
    config.instanceId,
    {
      name: 'pending-reference',
      idleDelayMs: config.reference.pollIntervalMs,
      errorDelayMs: 2000,
      maintenanceIntervalMs: config.backlogMetricsIntervalMs,
      shutdownTimeoutMs: config.consumer.shutdownTimeoutMs,
      batchSize: config.reference.batchSize,
      leaseMs: config.reference.leaseMs,
      concurrency: config.reference.concurrency,
    },
    core.logger,
  );
  const app = await createNestApp(core, WorkerModule.register(core, worker));
  await app.listen(config.metricsPort, '0.0.0.0');
});
