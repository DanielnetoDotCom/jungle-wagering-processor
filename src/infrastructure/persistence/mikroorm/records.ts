import { EntitySchema } from '@mikro-orm/core';

/*
 * Persistence records: plain data mapped with EntitySchema, so the domain has
 * no ORM decorators. Money columns are NUMERIC(20,2) exposed as strings (the
 * pg driver returns NUMERIC as text) and converted to `Money` by the mappers.
 * The schema itself (constraints, triggers, grants) is owned by the hand
 * written migrations, never generated from these definitions.
 */

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'string', length: 128 },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceAmount: { type: 'decimal', columnType: 'numeric(20,2)' },
    version: { type: 'integer' },
    createdAt: { type: 'datetime', columnType: 'timestamptz' },
    updatedAt: { type: 'datetime', columnType: 'timestamptz' },
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  channel!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string | null;
  gameId!: string | null;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  status!: string;
  failureCode!: string | null;
  resultBalanceAmount!: string | null;
  resultWalletVersion!: number | null;
  referenceAttempts!: number;
  nextAttemptAt!: Date | null;
  referenceExpiresAt!: Date | null;
  claimedBy!: string | null;
  claimExpiresAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
  processedAt!: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', length: 64 },
    externalTransactionId: { type: 'string', length: 128 },
    idempotencyKey: { type: 'string', length: 255 },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    channel: { type: 'string', length: 16 },
    walletId: { type: 'uuid' },
    playerId: { type: 'string', length: 128 },
    roundId: { type: 'string', length: 128, nullable: true },
    gameId: { type: 'string', length: 128, nullable: true },
    kind: { type: 'string', length: 16 },
    amount: { type: 'decimal', columnType: 'numeric(20,2)' },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: { type: 'string', length: 128, nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'string', length: 24 },
    failureCode: { type: 'string', length: 64, nullable: true },
    resultBalanceAmount: { type: 'decimal', columnType: 'numeric(20,2)', nullable: true },
    resultWalletVersion: { type: 'integer', nullable: true },
    referenceAttempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
    referenceExpiresAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
    claimedBy: { type: 'string', length: 128, nullable: true },
    claimExpiresAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
    createdAt: { type: 'datetime', columnType: 'timestamptz' },
    updatedAt: { type: 'datetime', columnType: 'timestamptz' },
    processedAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
  },
});

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'string', length: 6 },
    amount: { type: 'decimal', columnType: 'numeric(20,2)' },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceBefore: { type: 'decimal', columnType: 'numeric(20,2)' },
    balanceAfter: { type: 'decimal', columnType: 'numeric(20,2)' },
    walletVersion: { type: 'integer' },
    createdAt: { type: 'datetime', columnType: 'timestamptz' },
  },
});

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string | null;
  status!: string;
  outcome!: string | null;
  transactionId!: string | null;
  resultCode!: string | null;
  receiveCount!: number;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', length: 128, primary: true },
    messageId: { type: 'string', length: 256, primary: true },
    payloadHash: { type: 'string', columnType: 'char(64)', nullable: true },
    status: { type: 'string', length: 16 },
    outcome: { type: 'string', length: 32, nullable: true },
    transactionId: { type: 'uuid', nullable: true },
    resultCode: { type: 'string', length: 64, nullable: true },
    receiveCount: { type: 'integer' },
    receivedAt: { type: 'datetime', columnType: 'timestamptz' },
    processedAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
  },
});

export class OutboxMessageRecord {
  id!: string;
  aggregateType!: string;
  aggregateId!: string;
  eventType!: string;
  eventVersion!: number;
  messageGroupId!: string;
  correlationId!: string;
  causationId!: string | null;
  payload!: Record<string, unknown>;
  status!: string;
  attempts!: number;
  nextAttemptAt!: Date;
  claimedBy!: string | null;
  claimExpiresAt!: Date | null;
  lastError!: string | null;
  occurredAt!: Date;
  publishedAt!: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateType: { type: 'string', length: 64 },
    aggregateId: { type: 'string', length: 128 },
    eventType: { type: 'string', length: 128 },
    eventVersion: { type: 'integer' },
    messageGroupId: { type: 'string', length: 128 },
    correlationId: { type: 'string', length: 128 },
    causationId: { type: 'string', length: 256, nullable: true },
    payload: { type: 'json', columnType: 'jsonb' },
    status: { type: 'string', length: 16 },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime', columnType: 'timestamptz' },
    claimedBy: { type: 'string', length: 128, nullable: true },
    claimExpiresAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
    lastError: { type: 'string', length: 1024, nullable: true },
    occurredAt: { type: 'datetime', columnType: 'timestamptz' },
    publishedAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
  },
});

/** Registration order follows foreign-key dependencies (wallets -> transactions -> ledger -> messaging). */
export const ENTITY_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
