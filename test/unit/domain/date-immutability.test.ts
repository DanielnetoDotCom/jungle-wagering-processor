import { describe, expect, test } from 'bun:test';
import { WalletLedgerEntry } from '../../../src/domain/ledger/wallet-ledger-entry';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-direction';
import { WagerTransactionProcessed } from '../../../src/domain/events/wagering-events';
import { InboxMessage, InboxOutcome } from '../../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { WagerTransactionKind as Kind } from '../../../src/domain/wagering/wager-transaction-types';
import { brl, transaction } from './domain-builders';

const ISO = '2026-10-22T12:00:00.000Z';
const mutate = (date: Date) => date.setUTCFullYear(1999);

describe('Domain dates cannot be changed through an input or a getter', () => {
  test('ledger createdAt remains immutable after Date.setUTCFullYear', () => {
    const at = new Date(ISO);
    const entry = WalletLedgerEntry.create({
      id: 'e',
      walletId: 'w',
      transactionId: 't',
      walletVersion: 2,
      createdAt: at,
      direction: LedgerDirection.Credit,
      money: brl('1.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('1.00'),
    });
    mutate(at);
    mutate(entry.createdAt);
    expect(entry.createdAt.toISOString()).toBe(ISO);
  });

  test('wallet opening and movement dates are copied', () => {
    const at = new Date(ISO);
    const { wallet } = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: brl('0.00'),
      openedAt: at,
      opening: { transactionId: 't', ledgerEntryId: 'e' },
    });
    mutate(at);
    mutate(wallet.createdAt);
    mutate(wallet.updatedAt);
    expect(wallet.createdAt.toISOString()).toBe(ISO);
    expect(wallet.updatedAt.toISOString()).toBe(ISO);
    const movement = new Date(ISO);
    wallet.credit({ money: brl('1.00'), transactionId: 't2', ledgerEntryId: 'e2', at: movement });
    mutate(movement);
    expect(wallet.updatedAt.toISOString()).toBe(ISO);
  });

  test('pending schedules, settlement dates and result snapshots cannot be aliased', () => {
    const at = new Date(ISO);
    const tx = transaction(Kind.Refund, '1.00', { reference: 'missing', createdAt: at });
    const result = { balance: brl('10.00'), walletVersion: 1 };
    tx.markPendingReference({ at, nextAttemptAt: at, expiresAt: at, result });
    mutate(at);
    for (const date of [tx.createdAt, tx.updatedAt, tx.nextAttemptAt!, tx.referenceExpiresAt!]) mutate(date);
    result.walletVersion = 999;
    expect(tx.result?.walletVersion).toBe(1);
    expect(
      [tx.createdAt, tx.updatedAt, tx.nextAttemptAt!, tx.referenceExpiresAt!].map((date) =>
        date.toISOString(),
      ),
    ).toEqual([ISO, ISO, ISO, ISO]);
    const settledAt = new Date(ISO);
    tx.markProcessed({ at: settledAt, result, referenceTransactionId: 'reference-id' });
    mutate(settledAt);
    mutate(tx.processedAt!);
    expect(tx.processedAt?.toISOString()).toBe(ISO);
  });

  test('inbox, event and outbox dates do not expose mutable state', () => {
    const at = new Date(ISO);
    const inbox = InboxMessage.receive({
      messageId: 'm',
      consumerName: 'c',
      payloadHash: 'a'.repeat(64),
      receiveCount: 1,
      receivedAt: at,
    });
    inbox.markProcessed(at, { outcome: InboxOutcome.Applied });
    const tx = transaction(Kind.Bet, '1.00');
    tx.markProcessed({
      at,
      result: { balance: brl('0.00'), walletVersion: 2 },
      referenceTransactionId: undefined,
    });
    const event = WagerTransactionProcessed.from(tx, { eventId: 'e', correlationId: 'c', occurredAt: at });
    const outbox = OutboxMessage.enqueue(event, 'WagerTransaction');
    outbox.markPublished(at);
    mutate(at);
    for (const date of [
      inbox.receivedAt,
      inbox.processedAt!,
      event.occurredAt,
      outbox.occurredAt,
      outbox.nextAttemptAt,
      outbox.publishedAt!,
    ])
      mutate(date);
    expect(
      [
        inbox.receivedAt,
        inbox.processedAt!,
        event.occurredAt,
        outbox.occurredAt,
        outbox.nextAttemptAt,
        outbox.publishedAt!,
      ].map((date) => date.toISOString()),
    ).toEqual([ISO, ISO, ISO, ISO, ISO, ISO]);
  });
});
