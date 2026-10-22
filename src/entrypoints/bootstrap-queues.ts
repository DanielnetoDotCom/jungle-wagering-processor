import { runProcess } from '../bootstrap/process-runner';
import { createRootLogger, PinoLogger } from '../infrastructure/logging/logger';
import { ensureQueues } from '../infrastructure/messaging/sqs/queue-bootstrap';
import { createSqsClient } from '../infrastructure/messaging/sqs/sqs-client';
import { sleep } from '../shared/sleep';

/** Idempotent creation of the SQS FIFO queues and DLQ (job run on every `docker compose up`). */
void runProcess('queue-bootstrap', async (config) => {
  const logger = new PinoLogger(
    createRootLogger({
      level: config.logLevel,
      serviceName: config.serviceName,
      instanceId: config.instanceId,
    }),
  );
  const sqs = createSqsClient(config);
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const topology = await ensureQueues(sqs, config, logger);
        logger.info('SQS topology ready', { ...topology });
        return;
      } catch (error) {
        if (attempt >= 30) throw error;
        logger.warn('SQS not ready yet; retrying', {
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(Math.min(1000 * attempt, 5000));
      }
    }
  } finally {
    sqs.destroy();
  }
});
