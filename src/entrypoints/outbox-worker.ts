import 'reflect-metadata';
import { BacklogQueries } from '../application/queries/backlog-queries';
import { createCore } from '../bootstrap/core';
import { createNestApp } from '../bootstrap/nest/create-app';
import { WorkerModule } from '../bootstrap/nest/modules';
import { runProcess } from '../bootstrap/process-runner';
import { OutboxPublisherWorker } from '../workers/outbox/outbox-publisher.worker';

/** Outbox publisher process (several instances may run concurrently). */
void runProcess('outbox-worker', async (config) => {
  const core = await createCore(config);
  const worker = new OutboxPublisherWorker(
    core.publishOutbox,
    new BacklogQueries(core.uow, core.clock),
    core.metrics,
    config.instanceId,
    {
      name: 'outbox-publisher',
      idleDelayMs: config.outbox.pollIntervalMs,
      errorDelayMs: 2000,
      maintenanceIntervalMs: config.backlogMetricsIntervalMs,
      shutdownTimeoutMs: config.consumer.shutdownTimeoutMs,
    },
    core.logger,
  );
  const app = await createNestApp(core, WorkerModule.register(core, worker));
  await app.listen(config.metricsPort, '0.0.0.0');
});
