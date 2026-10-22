import type { LedgerDirection } from '../../../domain/ledger/ledger-direction';
import { WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry';
import { InboxMessage, type InboxOutcome, type InboxStatus } from '../../../domain/messaging/inbox-message';
import { OutboxMessage, type OutboxStatus } from '../../../domain/messaging/outbox-message';
import { Money } from '../../../domain/money/money';
import { WagerTransaction } from '../../../domain/wagering/wager-transaction';
import type {
  FailureCode,
  TransactionChannel,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wagering/wager-transaction-types';
import { Wallet } from '../../../domain/wallet/wallet';
import type {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './records';

/*
 * Database <-> domain translation. Rehydration uses the aggregates' `rehydrate`
 * factories: persisted state is trusted (it passed domain validation and the
 * database constraints when written) and no transition is replayed.
 * Enumerated columns are guarded by CHECK constraints, hence the casts.
 */

const money = (amount: string, currency: string): Money => Money.from({ amount, currency });
const orUndefined = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

export function toWallet(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: money(record.balanceAmount, record.currency),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function walletData(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balanceAmount: wallet.balance.amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function toWagerTransaction(record: WagerTransactionRecord): WagerTransaction {
  const result =
    record.resultBalanceAmount !== null && record.resultWalletVersion !== null
      ? {
          balance: money(record.resultBalanceAmount, record.currency),
          walletVersion: record.resultWalletVersion,
        }
      : undefined;
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    channel: record.channel as TransactionChannel,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: orUndefined(record.roundId),
    gameId: orUndefined(record.gameId),
    kind: record.kind as WagerTransactionKind,
    money: money(record.amount, record.currency),
    referenceExternalTransactionId: orUndefined(record.referenceExternalTransactionId),
    createdAt: record.createdAt,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: orUndefined(record.referenceTransactionId),
    failureCode: orUndefined(record.failureCode) as FailureCode | undefined,
    processedAt: orUndefined(record.processedAt),
    result,
    referenceAttempts: record.referenceAttempts,
    nextAttemptAt: orUndefined(record.nextAttemptAt),
    referenceExpiresAt: orUndefined(record.referenceExpiresAt),
    updatedAt: record.updatedAt,
  });
}

/** Saving through the domain always ends a worker claim: the attempt is over. */
export function wagerTransactionData(transaction: WagerTransaction): WagerTransactionRecord {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    channel: transaction.channel,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId ?? null,
    gameId: transaction.gameId ?? null,
    kind: transaction.kind,
    amount: transaction.money.amount,
    currency: transaction.money.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    resultBalanceAmount: transaction.result?.balance.amount ?? null,
    resultWalletVersion: transaction.result?.walletVersion ?? null,
    referenceAttempts: transaction.referenceAttempts,
    nextAttemptAt: transaction.nextAttemptAt ?? null,
    referenceExpiresAt: transaction.referenceExpiresAt ?? null,
    claimedBy: null,
    claimExpiresAt: null,
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
    processedAt: transaction.processedAt ?? null,
  };
}

export function toLedgerEntry(record: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as LedgerDirection,
    money: money(record.amount, record.currency),
    balanceBefore: money(record.balanceBefore, record.currency),
    balanceAfter: money(record.balanceAfter, record.currency),
    walletVersion: record.walletVersion,
    createdAt: record.createdAt,
  });
}

export function ledgerEntryData(entry: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.amount,
    balanceAfter: entry.balanceAfter.amount,
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt,
  };
}

export function toInboxMessage(record: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: record.messageId,
    consumerName: record.consumerName,
    payloadHash: orUndefined(record.payloadHash),
    receiveCount: record.receiveCount,
    receivedAt: record.receivedAt,
    status: record.status as InboxStatus,
    outcome: orUndefined(record.outcome) as InboxOutcome | undefined,
    transactionId: orUndefined(record.transactionId),
    resultCode: orUndefined(record.resultCode),
    processedAt: orUndefined(record.processedAt),
  });
}

export function inboxData(message: InboxMessage): InboxMessageRecord {
  return {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash ?? null,
    status: message.status,
    outcome: message.outcome ?? null,
    transactionId: message.transactionId ?? null,
    resultCode: message.resultCode ?? null,
    receiveCount: message.receiveCount,
    receivedAt: message.receivedAt,
    processedAt: message.processedAt ?? null,
  };
}

export function toOutboxMessage(record: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: record.id,
    aggregateType: record.aggregateType,
    aggregateId: record.aggregateId,
    eventType: record.eventType,
    eventVersion: record.eventVersion,
    messageGroupId: record.messageGroupId,
    correlationId: record.correlationId,
    causationId: orUndefined(record.causationId),
    payload: record.payload,
    occurredAt: record.occurredAt,
    status: record.status as OutboxStatus,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt,
    publishedAt: orUndefined(record.publishedAt),
    lastError: orUndefined(record.lastError),
  });
}

export function outboxData(message: OutboxMessage): OutboxMessageRecord {
  return {
    id: message.id,
    aggregateType: message.aggregateType,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    eventVersion: message.eventVersion,
    messageGroupId: message.messageGroupId,
    correlationId: message.correlationId,
    causationId: message.causationId ?? null,
    payload: { ...message.payload },
    status: message.status,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt,
    claimedBy: null,
    claimExpiresAt: null,
    lastError: message.lastError ?? null,
    occurredAt: message.occurredAt,
    publishedAt: message.publishedAt ?? null,
  };
}
