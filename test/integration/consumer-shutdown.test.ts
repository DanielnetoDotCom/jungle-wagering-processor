import { expect, test } from 'bun:test';
import type { Core } from '../../src/bootstrap/core';
import { NO_FAULTS } from '../../src/application/ports/runtime.ports';
import { RecordDeadLetterUseCase } from '../../src/application/use-cases/record-dead-letter.use-case';
import { RecordFailedAttemptUseCase } from '../../src/application/use-cases/record-failed-attempt.use-case';
import { WagerTransactionsConsumer } from '../../src/interfaces/consumers/wager-transactions.consumer';
import { createTestCore } from '../support/core';
import { TestDatabase } from '../support/database';
import { TestQueues } from '../support/sqs';
import { Latch, payload, ScriptedFaults, uniqueId, waitFor } from '../support/fixtures';
import { expectAllWalletsConsistent } from '../support/consistency';

test('expired shutdown releases the active batch, stops heartbeats and never acknowledges late work', async () => {
  const db = await TestDatabase.create('slow_shutdown');
  const queues = await TestQueues.create('slow-shutdown', { visibilityTimeoutSeconds: 4 });
  const latch = new Latch();
  const faults = new ScriptedFaults();
  faults.on('wager.before-commit', () => latch.wait());
  const core = await createTestCore(db, { queues: queues.names, overrides: { faults } });
  const replacement = await createTestCore(db, { queues: queues.names });
  const makeConsumer = (target: Core) =>
    new WagerTransactionsConsumer(
      target.sqs,
      target.queues,
      target.processWager,
      new RecordDeadLetterUseCase(target.uow, target.clock),
      new RecordFailedAttemptUseCase(target.uow, target.clock),
      target.metrics,
      target.logger,
      NO_FAULTS,
      {
        consumerName: 'slow-shutdown-test',
        queueName: queues.names.transactionsQueue,
        deadLetterQueueName: queues.names.transactionsDlq,
        waitTimeSeconds: 1,
        visibilityTimeoutSeconds: 4,
        maxMessages: 10,
        maxAttempts: 5,
        retryBaseMs: 1000,
        retryMaxMs: 1000,
        shutdownTimeoutMs: 100,
        dlqDepthIntervalMs: 500,
      },
      () => 0,
    );
  const consumer = makeConsumer(core);
  const survivor = makeConsumer(replacement);
  try {
    const wallet = await core.createWallet.execute({
      playerId: uniqueId('slow'),
      initialBalance: { amount: '100.00', currency: 'BRL' },
      correlationId: 'c',
    });
    for (const amount of ['10.00', '5.00']) {
      await queues.sendWager({
        messageId: uniqueId('slow-msg'),
        data: payload({ walletId: wallet.id, playerId: wallet.playerId, kind: 'BET', amount }),
      });
    }
    consumer.start();
    await latch.reached;
    await consumer.stop(); // SQL remains paused past the configured shutdown deadline.
    expect(await queues.counts(queues.urls.transactionsQueueUrl)).toEqual({ visible: 2, inFlight: 0 });
    await Bun.sleep(2100); // Span a heartbeat: the stopped owner must not extend visibility again.
    expect(await queues.counts(queues.urls.transactionsQueueUrl)).toEqual({ visible: 2, inFlight: 0 });
    survivor.start();
    await waitFor(async () =>
      /wagering_sqs_messages_received_total\{[^}]*\} [1-9]/.test(await replacement.metrics.render()),
    );
    faults.clear();
    latch.open();
    await waitFor(async () => {
      const counts = await queues.counts(queues.urls.transactionsQueueUrl);
      return counts.visible === 0 && counts.inFlight === 0;
    });
    expect((await core.queries.getWallet(wallet.id)).balance.amount).toBe('85.00');
    expect(await core.metrics.render()).not.toMatch(/wagering_sqs_messages_acked_total\{[^}]*\} [1-9]/);
    expect(await replacement.metrics.render()).toMatch(/wagering_inbox_duplicates_total\{[^}]*\} [1-9]/);
    await expectAllWalletsConsistent(db);
  } finally {
    faults.clear();
    latch.open();
    await consumer.stop();
    await survivor.stop();
    await core.close();
    await replacement.close();
    await queues.destroy();
    await db.drop();
  }
});
