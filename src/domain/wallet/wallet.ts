import {
  CurrencyMismatchError,
  DomainValidationError,
  InsufficientFundsError,
  InvariantViolationError,
} from '../errors/domain-errors';
import { LedgerDirection } from '../ledger/ledger-direction';
import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openedAt: Date;
  /** Required when initialBalance > 0: the internal OPENING transaction and its ledger line. */
  opening?: { transactionId: string; ledgerEntryId: string };
}

export interface WalletOpening {
  wallet: Wallet;
  /** Present only when the initial balance is positive: a zero balance has no financial movement. */
  openingEntry: WalletLedgerEntry | undefined;
}

export interface WalletMovementProps {
  money: Money;
  transactionId: string;
  ledgerEntryId: string;
  at: Date;
}

/** Balance and version observed at a given moment; stored as a transaction's result snapshot. */
export interface WalletSnapshot {
  balance: Money;
  walletVersion: number;
}

/**
 * Aggregate root. The balance can only change through `debit`/`credit`, and
 * every change returns exactly one ledger entry carrying the new version, so
 * the materialized balance and the ledger cannot diverge inside the domain.
 * `version` starts at 1 and increments only when the balance changes.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
  ) {
    this._createdAt = new Date(_createdAt.getTime());
    this._updatedAt = new Date(_updatedAt.getTime());
  }

  static open(props: OpenWalletProps): WalletOpening {
    if (props.id.trim() === '' || props.playerId.trim() === '') {
      throw new DomainValidationError('Wallet id and playerId are required');
    }
    if (props.initialBalance.isNegative()) {
      throw new DomainValidationError('Initial balance cannot be negative', 'initialBalance');
    }
    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.openedAt,
      props.openedAt,
    );
    if (props.initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }
    if (!props.opening) {
      throw new InvariantViolationError('A positive opening balance requires an OPENING transaction');
    }
    // The opening credit is part of creation: version stays 1 and the entry records 0 -> initial.
    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.ledgerEntryId,
      walletId: wallet.id,
      transactionId: props.opening.transactionId,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: Money.zero(wallet.currency),
      balanceAfter: props.initialBalance,
      walletVersion: 1,
      createdAt: props.openedAt,
    });
    return { wallet, openingEntry };
  }

  /** Reconstruction from persistence: no transition rule is re-applied. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  snapshot(): WalletSnapshot {
    return { balance: this._balance, walletVersion: this._version };
  }

  belongsTo(playerId: string): boolean {
    return this.playerId === playerId;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return this._balance.isGreaterThanOrEqual(money);
  }

  /** Throws InsufficientFundsError: callers decide the business failure code via `canDebit` first. */
  debit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertMovement(props.money);
    if (!this.canDebit(props.money)) {
      throw new InsufficientFundsError(this.id);
    }
    return this.apply(LedgerDirection.Debit, this._balance.subtract(props.money), props);
  }

  /** May throw MoneyOverflowError before any state change if the result exceeds NUMERIC(20,2). */
  credit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertMovement(props.money);
    return this.apply(LedgerDirection.Credit, this._balance.add(props.money), props);
  }

  private apply(
    direction: LedgerDirection,
    balanceAfter: Money,
    props: WalletMovementProps,
  ): WalletLedgerEntry {
    // Movements are time-ordered like versions even if the processing instance's
    // clock lags the one that wrote the previous version (small clock skew).
    const at = props.at.getTime() < this._updatedAt.getTime() ? this._updatedAt : props.at;
    const entry = WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: at,
    });
    // State changes only after the entry has been proven balanced.
    this._balance = balanceAfter;
    this._version = entry.walletVersion;
    this._updatedAt = new Date(at.getTime());
    return entry;
  }

  private assertMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new DomainValidationError('Wallet movements must have a positive amount', 'money');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
