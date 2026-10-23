import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { TransientInfrastructureError } from '../../src/application/errors/application-errors';
import type { SubmitWagerTransactionCommand } from '../../src/application/commands/wager-commands';
import type { ProcessWagerTransactionUseCase } from '../../src/application/use-cases/process-wager-transaction.use-case';
import { RecordDeadLetterUseCase } from '../../src/application/use-cases/record-dead-letter.use-case';
import { RecordFailedAttemptUseCase } from '../../src/application/use-cases/record-failed-attempt.use-case';
import type { Core } from '../../src/bootstrap/core';
import { WagerTransactionKind as Kind } from '../../src/domain/wagering/wager-transaction-types';
import { NO_FAULTS } from '../../src/application/ports/runtime.ports';
import { WagerTransactionsConsumer } from '../../src/interfaces/consumers/wager-transactions.consumer';
import { expectAllWalletsConsistent } from '../support/consistency';
import { createTestCore } from '../support/core';
import { TestDatabase } from '../support/database';
import { httpCommand, payload, uniqueId, waitFor } from '../support/fixtures';
import { TestQueues } from '../support/sqs';

describe('SQS consumer (LocalStack FIFO + inbox + DLQ)', () => {
  let db: TestDatabase;
  let queues: TestQueues;
  let core: Core;
  const running: WagerTransactionsConsumer[] = [];

  beforeAll(async () => {
    db = await TestDatabase.create('consumer');
    // Redrive at maxAttempts * maxMessages: only the consumer's own budget dead-letters here.
    queues = await TestQueues.create('consumer', {
      visibilityTimeoutSeconds: 5,
      maxReceiveCount: 30,
      consumerMaxAttempts: 3,
    });
    core = await createTestCore(db, { queues: queues.names });
  });

  afterEach(async () => {
    await Promise.all(running.splice(0).map((consumer) => consumer.stop()));
  });

  afterAll(async () => {
    await expectAllWalletsConsistent(db);
    await core.close();
    await queues.destroy();
    await db.drop();
  });

  function startConsumer(
    processWager: ProcessWagerTransactionUseCase = core.processWager,
    isDatabaseAvailable?: () => Promise<boolean>,
  ): WagerTransactionsConsumer {
    const consumer = new WagerTransactionsConsumer(
      core.sqs,
      core.queues,
      processWager,
      new RecordDeadLetterUseCase(core.uow, core.clock),
      new RecordFailedAttemptUseCase(core.uow, core.clock),
      core.metrics,
      core.logger,
      NO_FAULTS,
      {
        consumerName: 'wager-transactions-consumer',
        queueName: queues.names.transactionsQueue,
        deadLetterQueueName: queues.names.transactionsDlq,
        waitTimeSeconds: 1,
        visibilityTimeoutSeconds: 5,
        maxMessages: 10,
        maxAttempts: 3,
        retryBaseMs: 1000,
        retryMaxMs: 1000,
        shutdownTimeoutMs: 10_000,
        dlqDepthIntervalMs: 500,
        ...(isDatabaseAvailable ? { isDatabaseAvailable } : {}),
      },
      () => 0,
    );
    consumer.start();
    running.push(consumer);
    return consumer;
  }

  async function openWallet(amount = '100.00') {
    const playerId = uniqueId('player');
    const walletId = (
      await core.createWallet.execute({
        playerId,
        initialBalance: { amount, currency: 'BRL' },
        correlationId: 'c',
      })
    ).id;
    return { walletId, playerId };
  }

  async function queueEmpty(url: string): Promise<boolean> {
    const counts = await queues.counts(url);
    return counts.visible === 0 && counts.inFlight === 0;
  }

  async function transactionsOf(walletId: string) {
    return db.query<{ kind: string; status: string; failure_code: string | null; channel: string }>(
      `SELECT kind, status, failure_code, channel FROM wager_transactions WHERE wallet_id = $1 AND kind <> 'OPENING' ORDER BY created_at`,
      [walletId],
    );
  }

  test('processes a message through the same use case and acks only after the commit', async () => {
    startConsumer();
    const { walletId, playerId } = await openWallet();
    const messageId = uniqueId('msg');
    await queues.sendWager({
      messageId,
      data: payload({ walletId, playerId, kind: Kind.Bet, amount: '25.00' }),
    });

    await waitFor(async () => (await transactionsOf(walletId)).length === 1, {
      description: 'transaction recorded',
    });
    expect(await transactionsOf(walletId)).toEqual([
      { kind: 'BET', status: 'PROCESSED', failure_code: null, channel: 'SQS' },
    ]);
    const inbox = await db.one<{ status: string; outcome: string }>(
      `SELECT status, outcome FROM inbox_messages WHERE message_id = $1`,
      [messageId],
    );
    expect(inbox).toEqual({ status: 'PROCESSED', outcome: 'APPLIED' });
    await waitFor(() => queueEmpty(queues.urls.transactionsQueueUrl), { description: 'message deleted' });
  });

  test('the same message delivered twice (and the same operation via HTTP first) has a single effect', async () => {
    startConsumer();
    const { walletId, playerId } = await openWallet();
    const bet = payload({ walletId, playerId, kind: Kind.Bet, amount: '10.00' });
    await core.processWager.execute(httpCommand(bet));
    const messageId = uniqueId('msg');
    await queues.sendWager({ messageId, data: bet, deduplicationId: 'copy-1' });
    await queues.sendWager({ messageId, data: bet, deduplicationId: 'copy-2' });

    await waitFor(() => queueEmpty(queues.urls.transactionsQueueUrl), { description: 'both copies acked' });
    const lines = await db.one<{ count: number }>(
      `SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = $1`,
      [walletId],
    );
    expect(lines.count).toBe(2); // OPENING + one BET
    const inbox = await db.one<{ outcome: string }>(
      `SELECT outcome FROM inbox_messages WHERE message_id = $1`,
      [messageId],
    );
    expect(inbox.outcome).toBe('REPLAYED');
    expect(await core.metrics.render()).toMatch(/wagering_inbox_duplicates_total\{[^}]*\} [1-9]/);
  });

  test('a business rejection is terminal: recorded REJECTED and acked (not dead-lettered)', async () => {
    startConsumer();
    const { walletId, playerId } = await openWallet('5.00');
    await queues.sendWager({
      messageId: uniqueId('msg'),
      data: payload({ walletId, playerId, kind: Kind.Bet, amount: '50.00' }),
    });
    await waitFor(async () => (await transactionsOf(walletId)).length === 1);
    expect((await transactionsOf(walletId))[0]).toMatchObject({
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
    });
    await waitFor(() => queueEmpty(queues.urls.transactionsQueueUrl));
    expect((await queues.counts(queues.urls.transactionsDlqUrl)).visible).toBe(0);
  });

  test('invalid messages go straight to the DLQ and stay auditable in the inbox', async () => {
    startConsumer();
    const { walletId, playerId } = await openWallet();
    await queues.sendRaw('{not json', walletId);
    const opening = JSON.stringify({
      messageId: 'invalid-opening-1',
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        ...payload({ walletId, playerId, kind: Kind.Bet, amount: '1.00' }),
        kind: 'OPENING',
        idempotencyKey: 'k',
      },
    });
    await queues.sendRaw(opening, walletId);

    await waitFor(async () => (await queues.counts(queues.urls.transactionsDlqUrl)).visible === 2, {
      description: 'two dead letters',
    });
    const deadLetters = await queues.drain(queues.urls.transactionsDlqUrl);
    expect(deadLetters.map((message) => message.MessageAttributes?.deadLetterReason?.StringValue)).toEqual([
      'INVALID_MESSAGE',
      'INVALID_MESSAGE',
    ]);
    const audit = await db.one<{ status: string; result_code: string }>(
      `SELECT status, result_code FROM inbox_messages WHERE message_id = 'invalid-opening-1'`,
    );
    expect(audit).toEqual({ status: 'DEAD_LETTERED', result_code: 'VALIDATION_ERROR' });
    expect(await transactionsOf(walletId)).toEqual([]);
    expect(await queueEmpty(queues.urls.transactionsQueueUrl)).toBe(true);
  });

  test('a reused message id with another payload is dead-lettered', async () => {
    startConsumer();
    const { walletId, playerId } = await openWallet();
    const messageId = uniqueId('msg');
    await queues.sendWager({
      messageId,
      data: payload({ walletId, playerId, kind: Kind.Bet, amount: '1.00' }),
    });
    await waitFor(async () => (await transactionsOf(walletId)).length === 1);
    await queues.sendWager({
      messageId,
      data: payload({ walletId, playerId, kind: Kind.Bet, amount: '2.00' }),
    });
    await waitFor(async () => (await queues.counts(queues.urls.transactionsDlqUrl)).visible === 1, {
      description: 'dead letter',
    });
    const [deadLetter] = await queues.drain(queues.urls.transactionsDlqUrl);
    expect(deadLetter?.MessageAttributes?.deadLetterReason?.StringValue).toBe('MESSAGE_ID_CONFLICT');
    expect(await transactionsOf(walletId)).toHaveLength(1);
  });

  test('transient failures are retried with backoff (no ack) and then succeed exactly once', async () => {
    let failuresLeft = 2;
    const flaky = {
      execute: (command: SubmitWagerTransactionCommand) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          return Promise.reject(new TransientInfrastructureError('DATABASE_UNAVAILABLE', 'database is down'));
        }
        return core.processWager.execute(command);
      },
    } as unknown as ProcessWagerTransactionUseCase;
    startConsumer(flaky);
    const { walletId, playerId } = await openWallet();
    await queues.sendWager({
      messageId: uniqueId('msg'),
      data: payload({ walletId, playerId, kind: Kind.Bet, amount: '7.00' }),
    });

    await waitFor(async () => (await transactionsOf(walletId)).length === 1, {
      timeoutMs: 20_000,
      description: 'eventual success',
    });
    expect(failuresLeft).toBe(0);
    expect(await core.metrics.render()).toMatch(
      /wagering_sqs_message_retries_total\{[^}]*reason="DATABASE_UNAVAILABLE"[^}]*\} 2/,
    );
    await waitFor(() => queueEmpty(queues.urls.transactionsQueueUrl));
  });

  test('a database outage longer than the retry budget pauses consumption instead of dead-lettering', async () => {
    let databaseDown = true;
    let failures = 0;
    const outage = {
      execute: (command: SubmitWagerTransactionCommand) => {
        if (databaseDown) {
          failures += 1;
          return Promise.reject(new TransientInfrastructureError('DATABASE_UNAVAILABLE', 'database is down'));
        }
        return core.processWager.execute(command);
      },
    } as unknown as ProcessWagerTransactionUseCase;
    startConsumer(outage, () => Promise.resolve(!databaseDown));
    const { walletId, playerId } = await openWallet();
    await queues.sendWager({
      messageId: uniqueId('msg'),
      data: payload({ walletId, playerId, kind: Kind.Bet, amount: '3.00' }),
    });

    // Without the pause, maxAttempts=3 with 1s backoff would dead-letter it in ~3s.
    await waitFor(() => Promise.resolve(failures > 0), { description: 'first failure' });
    await new Promise((resolve) => setTimeout(resolve, 8000));
    expect(failures).toBe(1);
    expect(await core.metrics.render()).toMatch(/wagering_sqs_consumer_paused\{[^}]*\} 1/);
    databaseDown = false;

    await waitFor(async () => (await transactionsOf(walletId)).length === 1, {
      timeoutMs: 30_000,
      description: 'processed after the database came back',
    });
    expect((await queues.counts(queues.urls.transactionsDlqUrl)).visible).toBe(0);
    expect(await core.metrics.render()).toMatch(/wagering_sqs_consumer_paused\{[^}]*\} 0/);
  });

  test('a contract-valid message with a 256-character messageId is processed (correlation id stays within limits)', async () => {
    startConsumer();
    const { walletId, playerId } = await openWallet();
    const messageId = `m${'x'.repeat(255)}`;
    await queues.sendWager({
      messageId,
      data: payload({ walletId, playerId, kind: Kind.Bet, amount: '2.00' }),
      deduplicationId: uniqueId('dedup'), // SQS limits this id to 128 characters
    });
    await waitFor(async () => (await transactionsOf(walletId)).length === 1, { description: 'processed' });
    const event = await db.one<{ correlation_id: string; causation_id: string }>(
      `SELECT correlation_id, causation_id FROM outbox_messages WHERE message_group_id = $1 ORDER BY seq DESC LIMIT 1`,
      [walletId],
    );
    expect(event.causation_id).toBe(messageId);
    expect(event.correlation_id.length).toBeLessThanOrEqual(128);
  });

  async function attemptsOf(messageId: string) {
    return db.query<{ attempts: number; last_error_code: string }>(
      `SELECT attempts, last_error_code FROM inbox_attempts WHERE message_id = $1`,
      [messageId],
    );
  }

  test('a message failing transiently on every attempt (e.g. lock timeouts) is dead-lettered after maxAttempts real attempts', async () => {
    let calls = 0;
    const alwaysLocked = {
      execute: () => {
        calls += 1;
        return Promise.reject(
          new TransientInfrastructureError('LOCK_TIMEOUT', 'wallet is locked', 'lock_timeout'),
        );
      },
    } as unknown as ProcessWagerTransactionUseCase;
    startConsumer(alwaysLocked, () => Promise.resolve(true));
    const { walletId, playerId } = await openWallet();
    const messageId = uniqueId('msg');
    await queues.sendWager({
      messageId,
      data: payload({ walletId, playerId, kind: Kind.Bet, amount: '1.00' }),
    });

    await waitFor(async () => (await queues.counts(queues.urls.transactionsDlqUrl)).visible === 1, {
      timeoutMs: 30_000,
      description: 'dead-lettered by the consumer',
    });
    await waitFor(() => queueEmpty(queues.urls.transactionsQueueUrl), { description: 'source acked' });
    expect(calls).toBe(3);
    const [deadLetter] = await queues.drain(queues.urls.transactionsDlqUrl);
    expect(deadLetter?.MessageAttributes?.deadLetterReason?.StringValue).toBe('PROCESSING_FAILED');
    expect(deadLetter?.MessageAttributes?.errorCode?.StringValue).toBe('LOCK_TIMEOUT');
    expect(await core.metrics.render()).toMatch(
      /wagering_sqs_messages_dead_lettered_total\{[^}]*reason="PROCESSING_FAILED"[^}]*\} 1/,
    );
    const audit = await db.one<{ status: string; result_code: string }>(
      `SELECT status, result_code FROM inbox_messages WHERE message_id = $1`,
      [messageId],
    );
    expect(audit).toEqual({ status: 'DEAD_LETTERED', result_code: 'LOCK_TIMEOUT' });
    // Reset so that an operator redrive from the DLQ gets a full budget again.
    expect(await attemptsOf(messageId)).toEqual([{ attempts: 0, last_error_code: 'LOCK_TIMEOUT' }]);
    expect(await transactionsOf(walletId)).toEqual([]);
  });

  test('messages behind a failing FIFO group head keep their own budget: never dead-lettered unprocessed, order kept', async () => {
    const failingIds = [uniqueId('head-1'), uniqueId('head-2')];
    const headsLocked = {
      execute: (command: SubmitWagerTransactionCommand) =>
        failingIds.includes(command.causationId ?? '')
          ? Promise.reject(
              new TransientInfrastructureError('LOCK_TIMEOUT', 'wallet is locked', 'lock_timeout'),
            )
          : core.processWager.execute(command),
    } as unknown as ProcessWagerTransactionUseCase;
    const { walletId, playerId } = await openWallet();
    const followerId = uniqueId('follower');
    // All queued before the consumer starts, so receives return them together.
    for (const [index, messageId] of failingIds.entries()) {
      await queues.sendWager({
        messageId,
        data: payload({ walletId, playerId, kind: Kind.Bet, amount: `1.0${index}` }),
      });
    }
    await queues.sendWager({
      messageId: followerId,
      data: payload({ walletId, playerId, kind: Kind.Bet, amount: '2.00' }),
    });
    startConsumer(headsLocked, () => Promise.resolve(true));

    await waitFor(async () => (await transactionsOf(walletId)).length === 1, {
      timeoutMs: 45_000,
      description: 'follower processed after both heads were dead-lettered',
    });
    await waitFor(() => queueEmpty(queues.urls.transactionsQueueUrl), { description: 'source acked' });
    const deadLetters = await queues.drain(queues.urls.transactionsDlqUrl);
    expect(deadLetters.map((message) => message.MessageAttributes?.originalMessageId?.StringValue)).toEqual(
      failingIds,
    );
    const follower = await db.one<{ status: string; receive_count: number }>(
      `SELECT status, receive_count FROM inbox_messages WHERE message_id = $1`,
      [followerId],
    );
    // Received with the heads' 6 failed attempts, then processed on its first own
    // attempt. With the receive count as the budget (3), the queue redrive would
    // have dead-lettered it without a single attempt.
    expect(follower.status).toBe('PROCESSED');
    expect(follower.receive_count).toBeGreaterThan(3);
    expect(await attemptsOf(followerId)).toEqual([]);
    const lines = await db.query<{ amount: string }>(
      `SELECT amount::text FROM wallet_ledger_entries WHERE wallet_id = $1 AND wallet_version > 1`,
      [walletId],
    );
    expect(lines).toEqual([{ amount: '2.00' }]);
  });

  test('graceful stop: in-flight work completes, nothing is lost', async () => {
    const consumer = startConsumer();
    const { walletId, playerId } = await openWallet('1000.00');
    for (let index = 0; index < 20; index += 1) {
      await queues.sendWager({
        messageId: uniqueId('msg'),
        data: payload({ walletId, playerId, kind: Kind.Bet, amount: '1.00' }),
      });
    }
    await waitFor(async () => (await transactionsOf(walletId)).length > 0);
    await consumer.stop();
    running.splice(running.indexOf(consumer), 1);
    const afterStop = (await transactionsOf(walletId)).length;
    startConsumer();
    await waitFor(async () => (await transactionsOf(walletId)).length === 20, {
      timeoutMs: 30_000,
      description: 'all 20 processed',
    });
    expect(afterStop).toBeLessThanOrEqual(20);
    const lines = await db.one<{ count: number }>(
      `SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = $1`,
      [walletId],
    );
    expect(lines.count).toBe(21);
  });
});
