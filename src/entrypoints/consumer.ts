import 'reflect-metadata';
import { RecordDeadLetterUseCase } from '../application/use-cases/record-dead-letter.use-case';
import { RecordFailedAttemptUseCase } from '../application/use-cases/record-failed-attempt.use-case';
import { createCore } from '../bootstrap/core';
import { createNestApp } from '../bootstrap/nest/create-app';
import { WorkerModule } from '../bootstrap/nest/modules';
import { runProcess } from '../bootstrap/process-runner';
import { EnvFaultInjector } from '../infrastructure/runtime/runtime-adapters';
import { WagerTransactionsConsumer } from '../interfaces/consumers/wager-transactions.consumer';

/** SQS consumer process: same use case as the HTTP API, inbox deduplication, ack after commit. */
void runProcess('consumer', async (config) => {
  const core = await createCore(config);
  const consumer = new WagerTransactionsConsumer(
    core.sqs,
    core.queues,
    core.processWager,
    new RecordDeadLetterUseCase(core.uow, core.clock),
    new RecordFailedAttemptUseCase(core.uow, core.clock),
    core.metrics,
    core.logger,
    new EnvFaultInjector(config.faultInjection.enabled, config.faultInjection.spec, core.logger),
    {
      consumerName: config.consumer.name,
      queueName: config.sqs.transactionsQueue,
      deadLetterQueueName: config.sqs.transactionsDlq,
      waitTimeSeconds: config.sqs.waitTimeSeconds,
      visibilityTimeoutSeconds: config.sqs.visibilityTimeoutSeconds,
      maxMessages: config.sqs.maxMessages,
      maxAttempts: config.consumer.maxAttempts,
      retryBaseMs: config.sqs.retryBaseMs,
      retryMaxMs: config.sqs.retryMaxMs,
      shutdownTimeoutMs: config.consumer.shutdownTimeoutMs,
      dlqDepthIntervalMs: config.backlogMetricsIntervalMs,
      isDatabaseAvailable: () => core.health.isPostgresAvailable(),
    },
  );
  const app = await createNestApp(core, WorkerModule.register(core, consumer));
  await app.listen(config.metricsPort, '0.0.0.0');
});
