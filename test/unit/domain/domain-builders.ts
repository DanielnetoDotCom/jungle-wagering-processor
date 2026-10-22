import { Money } from '../../../src/domain/money/money';
import { WagerTransaction } from '../../../src/domain/wagering/wager-transaction';
import {
  TransactionChannel,
  WagerTransactionKind,
} from '../../../src/domain/wagering/wager-transaction-types';
import { Wallet } from '../../../src/domain/wallet/wallet';

export const NOW = new Date('2026-10-22T12:00:00.000Z');
export const HASH = 'a'.repeat(64);
export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

let counter = 0;
export const nextId = (prefix: string) => `${prefix}-${++counter}`;

export function wallet(balance: string, overrides: { id?: string; playerId?: string } = {}): Wallet {
  return Wallet.rehydrate({
    id: overrides.id ?? 'wallet-1',
    playerId: overrides.playerId ?? 'player-1',
    currency: 'BRL',
    balance: brl(balance),
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

export function transaction(
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<{
    externalTransactionId: string;
    reference: string;
    walletId: string;
    playerId: string;
    roundId: string;
    currency: string;
    providerId: string;
    createdAt: Date;
  }> = {},
): WagerTransaction {
  return WagerTransaction.create({
    id: nextId('tx'),
    providerId: overrides.providerId ?? 'provider-a',
    externalTransactionId: overrides.externalTransactionId ?? nextId('ext'),
    idempotencyKey: nextId('key'),
    payloadHash: HASH,
    channel: kind === WagerTransactionKind.Opening ? TransactionChannel.Internal : TransactionChannel.Http,
    walletId: overrides.walletId ?? 'wallet-1',
    playerId: overrides.playerId ?? 'player-1',
    roundId: kind === WagerTransactionKind.Opening ? undefined : (overrides.roundId ?? 'round-1'),
    gameId: kind === WagerTransactionKind.Opening ? undefined : 'game-1',
    kind,
    money: Money.from({ amount, currency: overrides.currency ?? 'BRL' }),
    referenceExternalTransactionId: overrides.reference,
    createdAt: overrides.createdAt ?? NOW,
  });
}

/** A transaction already PROCESSED (as if loaded from the database). */
export function processed(
  kind: WagerTransactionKind,
  amount: string,
  overrides: Parameters<typeof transaction>[2] = {},
): WagerTransaction {
  const tx = transaction(kind, amount, overrides);
  tx.markProcessed({
    referenceTransactionId: tx.hasReference() ? 'some-reference-id' : undefined,
    at: NOW,
    result: { balance: brl('0.00'), walletVersion: 1 },
  });
  return tx;
}
