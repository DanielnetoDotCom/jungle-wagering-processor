import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  MoneyOverflowError,
  UnsupportedCurrencyError,
} from '../../../src/domain/errors/domain-errors';
import { Money } from '../../../src/domain/money/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money: parsing contract inputs', () => {
  test.each(['0.00', '0.01', '25.00', '1000.10', '999999999999999999.99'])('accepts %p', (amount) => {
    expect(brl(amount).amount).toBe(amount);
  });

  test.each([
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['scientific notation', '1e3'],
    ['scientific with decimals', '1.00e2'],
    ['empty string', ''],
    ['blank', ' '],
    ['leading space', ' 1.00'],
    ['trailing space', '1.00 '],
    ['missing decimals', '25'],
    ['one decimal', '25.5'],
    ['three decimals (no silent rounding)', '25.001'],
    ['negative input', '-1.00'],
    ['explicit plus sign', '+1.00'],
    ['leading zero', '01.00'],
    ['comma separator', '1,00'],
    ['thousands separator', '1,000.00'],
    ['hex', '0x10'],
    ['19 integer digits (overflow of NUMERIC(20,2))', '1000000000000000000.00'],
  ])('rejects %s', (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejects non-string amounts (numbers are never accepted for money)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each(['brl', 'XYZ', 'JPY', 'BHD', '', 'BR'])(
    'rejects currency %p (unknown or not 2 minor units)',
    (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(UnsupportedCurrencyError);
    },
  );
});

describe('Money: exact arithmetic', () => {
  test('0.10 + 0.20 is exactly 0.30 (no floating point drift)', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
  });

  test('large values keep every cent', () => {
    expect(brl('999999999999999998.99').add(brl('1.00')).amount).toBe('999999999999999999.99');
    expect(brl('123456789012345678.91').subtract(brl('0.01')).amount).toBe('123456789012345678.90');
  });

  test('subtract may produce internal negative differences, negate flips the sign', () => {
    const difference = brl('10.00').subtract(brl('12.35'));
    expect(difference.amount).toBe('-2.35');
    expect(difference.isNegative()).toBe(true);
    expect(difference.negate().amount).toBe('2.35');
  });

  test('negative zero is normalised', () => {
    expect(brl('0.00').negate().amount).toBe('0.00');
    expect(brl('5.00').subtract(brl('5.00')).isZero()).toBe(true);
    expect(brl('5.00').subtract(brl('5.00')).isNegative()).toBe(false);
  });

  test('overflow beyond NUMERIC(20,2) throws instead of losing precision', () => {
    expect(() => brl('999999999999999999.99').add(brl('0.01'))).toThrow(MoneyOverflowError);
  });

  test('fromSigned parses internal signed values but keeps the scale rule', () => {
    expect(Money.fromSigned({ amount: '-7.50', currency: 'BRL' }).amount).toBe('-7.50');
    expect(() => Money.fromSigned({ amount: '-7.5', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });
});

describe('Money: currencies', () => {
  const usd = Money.from({ amount: '1.00', currency: 'USD' });

  test('arithmetic between currencies throws', () => {
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
  });

  test('comparisons between currencies throw', () => {
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').compareTo(usd)).toThrow(CurrencyMismatchError);
  });

  test('equality between currencies is simply false', () => {
    expect(brl('1.00').equals(usd)).toBe(false);
  });
});

describe('Money: comparisons, immutability and serialization', () => {
  test('comparisons', () => {
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isGreaterThan(brl('1.00'))).toBe(true);
    expect(brl('1.00').isGreaterThanOrEqual(brl('1.00'))).toBe(true);
    expect(brl('1.00').compareTo(brl('1.00'))).toBe(0);
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('1.00').equals(brl('1.00'))).toBe(true);
  });

  test('is immutable: operations return new instances and the object is frozen', () => {
    const original = brl('10.00');
    const sum = original.add(brl('5.00'));
    expect(sum).not.toBe(original);
    expect(original.amount).toBe('10.00');
    expect(Object.isFrozen(original)).toBe(true);
    expect(() => {
      (original as unknown as { currency: string }).currency = 'USD';
    }).toThrow();
  });

  test('serializes as decimal strings with scale 2', () => {
    const money = brl('25.00');
    expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(JSON.stringify({ money })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
    expect(money.toString()).toBe('25.00 BRL');
    expect(Money.zero('BRL').toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });
});
