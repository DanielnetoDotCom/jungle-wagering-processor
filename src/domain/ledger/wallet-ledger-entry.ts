import { InvariantViolationError } from '../errors/domain-errors';
import { Money } from '../money/money';
import { LedgerDirection } from './ledger-direction';

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Append-only ledger line. Structurally immutable: no mutable fields and no
 * transition methods. `create` proves the arithmetic
 * (balanceBefore ± money === balanceAfter) before the entry can exist.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    private readonly createdAtMs: number,
  ) {
    Object.freeze(this);
  }

  get createdAt(): Date {
    return new Date(this.createdAtMs);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.build(props);
    if (!entry.money.isPositive()) {
      throw new InvariantViolationError('Ledger entries must move a positive amount');
    }
    if (entry.balanceBefore.isNegative() || entry.balanceAfter.isNegative()) {
      throw new InvariantViolationError('Ledger balances can never be negative');
    }
    if (
      entry.money.currency !== entry.balanceBefore.currency ||
      entry.money.currency !== entry.balanceAfter.currency
    ) {
      throw new InvariantViolationError('Ledger entry currencies must match');
    }
    if (!Number.isInteger(entry.walletVersion) || entry.walletVersion < 1) {
      throw new InvariantViolationError('Ledger wallet version must be a positive integer');
    }
    if (!entry.isBalanced()) {
      throw new InvariantViolationError(
        `Unbalanced ledger entry: ${entry.balanceBefore.toString()} ${entry.direction} ${entry.money.toString()} != ${entry.balanceAfter.toString()}`,
      );
    }
    return entry;
  }

  /** Rebuilds a persisted entry. Arithmetic was proven at creation and by the database CHECK. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(state);
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Effect on the balance: +money for credits, -money for debits. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }

  private static build(props: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.walletVersion,
      props.createdAt.getTime(),
    );
  }
}
