import { Decimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError, MoneyOverflowError } from '../errors/domain-errors';
import { assertCurrency } from './currency';

/**
 * Dedicated Decimal constructor: 40 significant digits is far beyond
 * NUMERIC(20,2), so additions/subtractions are always exact. Rounding is never
 * applied implicitly: inputs with more than 2 decimals are rejected.
 */
const MoneyDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -40,
  toExpPos: 40,
});

export const MONEY_SCALE = 2;
/** Matches the PostgreSQL column type NUMERIC(20, 2): 18 integer digits. */
export const MONEY_MAX_INTEGER_DIGITS = 18;

const MAX_ABSOLUTE_VALUE = new MoneyDecimal('999999999999999999.99');
/** Canonical contract format: no sign, no leading zeros, exactly two decimals. */
const UNSIGNED_AMOUNT = /^(0|[1-9]\d{0,17})\.\d{2}$/;
/** Internal signed format used only for computed differences (never for inputs). */
const SIGNED_AMOUNT = /^-?(0|[1-9]\d{0,17})\.\d{2}$/;
const MAX_INPUT_LENGTH = 32;

/** Wire/DTO representation. Amount is always a decimal string with scale 2. */
export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

/**
 * Immutable monetary value object. Every operation returns a new instance and
 * validates currencies; arithmetic is exact (decimal.js), never floating point.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /**
   * Parses an amount coming from an external contract (HTTP, SQS, database
   * column). Accepts only non-negative values with exactly two decimals.
   * Rejects NaN, Infinity, scientific notation, signs, blanks and >2 decimals.
   */
  static from(props: MoneyProps): Money {
    const currency = assertCurrency(props.currency);
    const amount = Money.assertAmountString(props.amount, UNSIGNED_AMOUNT);
    return Money.of(new MoneyDecimal(amount), currency);
  }

  /**
   * Parses a signed amount produced internally (e.g. a reconciliation
   * difference or a SUM computed by the database). Never use it for inputs.
   */
  static fromSigned(props: MoneyProps): Money {
    const currency = assertCurrency(props.currency);
    const amount = Money.assertAmountString(props.amount, SIGNED_AMOUNT);
    return Money.of(new MoneyDecimal(amount), currency);
  }

  static zero(currency: string): Money {
    return Money.of(new MoneyDecimal(0), assertCurrency(currency));
  }

  /** Decimal string with exactly two decimal places, e.g. "25.00" or "-3.10". */
  get amount(): string {
    return this.value.toFixed(MONEY_SCALE);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    return this.compareTo(other) < 0;
  }

  isGreaterThan(other: Money): boolean {
    return this.compareTo(other) > 0;
  }

  isGreaterThanOrEqual(other: Money): boolean {
    return this.compareTo(other) >= 0;
  }

  /** -1, 0 or 1. Throws on currency mismatch: ordering different currencies is meaningless. */
  compareTo(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    const result = this.value.comparedTo(other.value);
    return result < 0 ? -1 : result > 0 ? 1 : 0;
  }

  /** Value equality. Different currencies are simply not equal (no exception). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static of(value: Decimal, currency: string): Money {
    if (!value.isFinite()) {
      throw new InvalidMoneyError('Monetary value must be finite');
    }
    if (value.decimalPlaces() > MONEY_SCALE) {
      throw new InvalidMoneyError(`Monetary value cannot have more than ${MONEY_SCALE} decimal places`);
    }
    if (value.abs().greaterThan(MAX_ABSOLUTE_VALUE)) {
      throw new MoneyOverflowError();
    }
    // Normalise negative zero so "-0.00" can never be produced.
    return new Money(value.isZero() ? new MoneyDecimal(0) : value, currency);
  }

  private static assertAmountString(amount: unknown, pattern: RegExp): string {
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('Amount must be a decimal string such as "25.00"');
    }
    if (amount.length === 0 || amount.length > MAX_INPUT_LENGTH || !pattern.test(amount)) {
      throw new InvalidMoneyError(
        `Invalid amount "${amount.slice(0, MAX_INPUT_LENGTH)}": expected a non-negative decimal string with exactly ${MONEY_SCALE} decimal places and at most ${MONEY_MAX_INTEGER_DIGITS} integer digits`,
      );
    }
    return amount;
  }
}
