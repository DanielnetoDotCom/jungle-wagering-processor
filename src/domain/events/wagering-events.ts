import { InvariantViolationError } from '../errors/domain-errors';
import type { LedgerDirection } from '../ledger/ledger-direction';
import type { WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import type { MoneyProps } from '../money/money';
import type { WagerTransaction } from '../wagering/wager-transaction';
import type { FailureCode, WagerTransactionKind } from '../wagering/wager-transaction-types';
import type { Wallet } from '../wallet/wallet';
import { type EventContext, IntegrationEvent } from './integration-event';

interface TransactionIdentity {
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
}

export interface WagerTransactionProcessedData extends TransactionIdentity {
  referenceTransactionId: string | null;
  /** Balance observed right after the transaction (unchanged for LOSS). */
  balance: MoneyProps;
  walletVersion: number;
  processedAt: string;
}

export interface WagerTransactionRejectedData extends TransactionIdentity {
  failureCode: FailureCode;
  balance: MoneyProps;
  walletVersion: number;
  rejectedAt: string;
}

export interface WagerTransactionFailedData extends TransactionIdentity {
  failureCode: FailureCode;
  failedAt: string;
}

export interface WagerTransactionPendingReferenceData extends TransactionIdentity {
  nextAttemptAt: string;
  expiresAt: string;
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

function identityOf(transaction: WagerTransaction): TransactionIdentity {
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
  };
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new InvariantViolationError(`Cannot build event: ${what} is missing`);
  }
  return value;
}

/** Any applied transaction, including LOSS (which has no balance effect). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    const result = required(transaction.result, 'result snapshot');
    return new WagerTransactionProcessed({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...identityOf(transaction),
        referenceTransactionId: transaction.referenceTransactionId ?? null,
        balance: result.balance.toJSON(),
        walletVersion: result.walletVersion,
        processedAt: required(transaction.processedAt, 'processedAt').toISOString(),
      },
    });
  }

  messageGroupId(): string {
    return this.data.walletId;
  }
}

/** Business-rule rejection; carries the stable failure code. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    const result = required(transaction.result, 'result snapshot');
    return new WagerTransactionRejected({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...identityOf(transaction),
        failureCode: required(transaction.failureCode, 'failureCode'),
        balance: result.balance.toJSON(),
        walletVersion: result.walletVersion,
        rejectedAt: required(transaction.processedAt, 'processedAt').toISOString(),
      },
    });
  }

  messageGroupId(): string {
    return this.data.walletId;
  }
}

/** Permanent processing failure (terminal, never moved money). */
export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionFailed {
    return new WagerTransactionFailed({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...identityOf(transaction),
        failureCode: required(transaction.failureCode, 'failureCode'),
        failedAt: required(transaction.processedAt, 'processedAt').toISOString(),
      },
    });
  }

  messageGroupId(): string {
    return this.data.walletId;
  }
}

/** The referenced transaction is not available yet; the transaction will be retried. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...identityOf(transaction),
        nextAttemptAt: required(transaction.nextAttemptAt, 'nextAttemptAt').toISOString(),
        expiresAt: required(transaction.referenceExpiresAt, 'referenceExpiresAt').toISOString(),
      },
    });
  }

  messageGroupId(): string {
    return this.data.walletId;
  }
}

/** Emitted only when the balance actually changes (one per ledger entry). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, context: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvariantViolationError('Ledger entry does not belong to the wallet');
    }
    return new WalletBalanceChanged({
      ...context,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }

  messageGroupId(): string {
    return this.data.walletId;
  }
}
