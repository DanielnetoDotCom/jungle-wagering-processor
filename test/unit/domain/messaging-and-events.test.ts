import { describe, expect, test } from 'bun:test';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../../src/domain/events/wagering-events';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-direction';
import { InboxMessage, InboxOutcome, InboxStatus } from '../../../src/domain/messaging/inbox-message';
import { OutboxMessage, OutboxStatus } from '../../../src/domain/messaging/outbox-message';
import { InvalidTransactionStateError } from '../../../src/domain/errors/domain-errors';
import { WagerTransactionKind as Kind } from '../../../src/domain/wagering/wager-transaction-types';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { ExponentialBackoff } from '../../../src/shared/backoff';
import { brl, NOW, transaction } from './domain-builders';

const context = { eventId: 'event-1', correlationId: 'corr-1', causationId: 'msg-1', occurredAt: NOW };

describe('Integration events', () => {
  test('envelope carries type/version from the class and money as decimal strings', () => {
    const bet = transaction(Kind.Bet, '25.00');
    bet.markProcessed({
      referenceTransactionId: undefined,
      at: NOW,
      result: { balance: brl('75.00'), walletVersion: 2 },
    });
    const envelope = WagerTransactionProcessed.from(bet, context).toJSON();
    expect(envelope).toMatchObject({
      eventId: 'event-1',
      eventType: 'WagerTransactionProcessed',
      version: 1,
      aggregateId: bet.id,
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-10-22T12:00:00.000Z',
    });
    expect(envelope.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(envelope.data.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
  });

  test('WalletBalanceChanged mirrors the ledger entry and is grouped by wallet', () => {
    const { wallet } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('100.00'),
      openedAt: NOW,
      opening: { transactionId: 'o', ledgerEntryId: 'e0' },
    });
    const entry = wallet.debit({ money: brl('30.00'), transactionId: 'tx-1', ledgerEntryId: 'e1', at: NOW });
    const event = WalletBalanceChanged.from(wallet, entry, context);
    expect(event.messageGroupId()).toBe('wallet-1');
    expect(event.toJSON().data).toEqual({
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Debit,
      money: { amount: '30.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '70.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });
});

describe('OutboxMessage', () => {
  const backoff = new ExponentialBackoff({
    baseDelayMs: 1000,
    maxDelayMs: 60_000,
    jitterRatio: 0,
    maxAttempts: 3,
  });

  function enqueued(): OutboxMessage {
    const bet = transaction(Kind.Bet, '1.00');
    bet.markProcessed({
      referenceTransactionId: undefined,
      at: NOW,
      result: { balance: brl('1.00'), walletVersion: 2 },
    });
    return OutboxMessage.enqueue(WagerTransactionProcessed.from(bet, context), 'WagerTransaction');
  }

  test('enqueue keeps the eventId as identity and the envelope as payload; due immediately', () => {
    const message = enqueued();
    expect(message.id).toBe('event-1');
    expect(message.isPending()).toBe(true);
    expect(message.isDue(NOW)).toBe(true);
    expect(message.payload).toMatchObject({ eventType: 'WagerTransactionProcessed', eventId: 'event-1' });
    expect(message.messageGroupId).toBe('wallet-1');
  });

  test('scheduleRetry backs off and retains the event as DEAD after max attempts', () => {
    const state = (attempts: number) =>
      OutboxMessage.rehydrate({
        id: 'e',
        aggregateType: 'X',
        aggregateId: 'a',
        eventType: 'T',
        eventVersion: 1,
        messageGroupId: 'g',
        correlationId: 'c',
        causationId: undefined,
        payload: {},
        occurredAt: NOW,
        status: OutboxStatus.Pending,
        attempts,
        nextAttemptAt: NOW,
        publishedAt: undefined,
        lastError: undefined,
      });
    const retried = state(2);
    retried.scheduleRetry(NOW, backoff, 'boom');
    expect(retried.isPending()).toBe(true);
    expect(retried.nextAttemptAt.getTime()).toBe(NOW.getTime() + 2000);
    expect(retried.lastError).toBe('boom');

    const exhausted = state(3);
    exhausted.scheduleRetry(NOW, backoff, 'still failing');
    expect(exhausted.status).toBe(OutboxStatus.Dead);
    expect(() => exhausted.scheduleRetry(NOW, backoff, 'x')).toThrow(InvalidTransactionStateError);
  });

  test('markPublished is idempotent', () => {
    const message = enqueued();
    message.markPublished(NOW);
    message.markPublished(new Date(NOW.getTime() + 1));
    expect(message.publishedAt).toEqual(NOW);
  });
});

describe('InboxMessage', () => {
  test('received -> processed is final', () => {
    const inbox = InboxMessage.receive({
      messageId: 'm',
      consumerName: 'c',
      payloadHash: 'h',
      receiveCount: 1,
      receivedAt: NOW,
    });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(NOW, { outcome: InboxOutcome.Applied, transactionId: 't' });
    expect(inbox.status).toBe(InboxStatus.Processed);
    expect(() => inbox.markProcessed(NOW, { outcome: InboxOutcome.Replayed })).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => inbox.markDeadLettered('X', 2)).toThrow(InvalidTransactionStateError);
  });

  test('a dead-lettered message can still be processed after an operator redrive', () => {
    const inbox = InboxMessage.receive({
      messageId: 'm',
      consumerName: 'c',
      payloadHash: 'h',
      receiveCount: 5,
      receivedAt: NOW,
    });
    inbox.markDeadLettered('PROCESSING_FAILED', 5);
    expect(inbox.status).toBe(InboxStatus.DeadLettered);
    inbox.registerRedelivery(6, 'h');
    inbox.markProcessed(NOW, { outcome: InboxOutcome.Applied });
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.receiveCount).toBe(6);
  });

  test('a never-processed row adopts the payload it is finally processed with', () => {
    // dead-lettered as unparseable: no hash recorded
    const inbox = InboxMessage.receive({
      messageId: 'm',
      consumerName: 'c',
      payloadHash: undefined,
      receiveCount: 1,
      receivedAt: NOW,
    });
    inbox.markDeadLettered('INVALID_MESSAGE', 1);
    expect(() => inbox.markProcessed(NOW, { outcome: InboxOutcome.Applied })).toThrow(
      InvalidTransactionStateError,
    );
    inbox.registerRedelivery(1, 'corrected-hash');
    inbox.markProcessed(NOW, { outcome: InboxOutcome.Applied });
    expect(inbox.matchesPayload('corrected-hash')).toBe(true);
    expect(() => inbox.registerRedelivery(2, 'other')).toThrow(InvalidTransactionStateError);
  });
});

describe('ExponentialBackoff', () => {
  test('deterministic without jitter, capped, bounded jitter otherwise', () => {
    const plain = new ExponentialBackoff({
      baseDelayMs: 100,
      maxDelayMs: 1000,
      jitterRatio: 0,
      maxAttempts: 9,
    });
    expect([1, 2, 3, 4, 5, 6].map((attempt) => plain.delayAfterAttempt(attempt))).toEqual([
      100, 200, 400, 800, 1000, 1000,
    ]);
    const jittered = new ExponentialBackoff(
      { baseDelayMs: 1000, maxDelayMs: 10_000, jitterRatio: 0.5, maxAttempts: 9 },
      () => 1,
    );
    expect(jittered.delayAfterAttempt(1)).toBe(500);
  });
});
