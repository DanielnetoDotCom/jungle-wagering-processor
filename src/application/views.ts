import type { WalletLedgerEntry } from '../domain/ledger/wallet-ledger-entry';
import type { MoneyProps } from '../domain/money/money';
import type { WagerTransaction } from '../domain/wagering/wager-transaction';
import type {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wagering/wager-transaction-types';
import type { Wallet } from '../domain/wallet/wallet';

/** Read model returned by use cases; built from aggregates after the transaction commits. */
export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: WagerTransactionStatus;
  failureCode: FailureCode | null;
  /** Balance observed when the transaction reached its current state (historical, not current). */
  balance: MoneyProps | null;
  walletVersion: number | null;
  referenceAttempts: number;
  nextAttemptAt: string | null;
  createdAt: string;
  processedAt: string | null;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntryView {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export function toTransactionView(transaction: WagerTransaction): WagerTransactionView {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId ?? null,
    gameId: transaction.gameId ?? null,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    balance: transaction.result?.balance.toJSON() ?? null,
    walletVersion: transaction.result?.walletVersion ?? null,
    referenceAttempts: transaction.referenceAttempts,
    nextAttemptAt: transaction.nextAttemptAt?.toISOString() ?? null,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export function toLedgerEntryView(entry: WalletLedgerEntry): LedgerEntryView {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}
