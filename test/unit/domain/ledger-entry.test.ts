import { describe, expect, test } from 'bun:test';
import { InvariantViolationError } from '../../../src/domain/errors/domain-errors';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-direction';
import { WalletLedgerEntry } from '../../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../../src/domain/money/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const base = {
  id: 'e1',
  walletId: 'w1',
  transactionId: 't1',
  walletVersion: 2,
  createdAt: new Date('2026-10-22T12:00:00.000Z'),
};

describe('WalletLedgerEntry', () => {
  test('a CREDIT must satisfy balanceAfter = balanceBefore + amount', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('10.00'),
      balanceBefore: brl('5.00'),
      balanceAfter: brl('15.00'),
    });
    expect(entry.isBalanced()).toBe(true);
    expect(entry.signedAmount().amount).toBe('10.00');
  });

  test('a DEBIT must satisfy balanceAfter = balanceBefore - amount', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('10.00'),
      balanceBefore: brl('15.00'),
      balanceAfter: brl('5.00'),
    });
    expect(entry.signedAmount().amount).toBe('-10.00');
  });

  test('unbalanced arithmetic is refused at creation', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('15.00'),
        balanceAfter: brl('6.00'),
      }),
    ).toThrow(InvariantViolationError);
  });

  test('zero amounts, negative balances and mixed currencies are refused', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('0.00'),
        balanceBefore: brl('1.00'),
        balanceAfter: brl('1.00'),
      }),
    ).toThrow(InvariantViolationError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('2.00'),
        balanceBefore: brl('1.00'),
        balanceAfter: brl('1.00').subtract(brl('2.00')),
      }),
    ).toThrow(InvariantViolationError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: '1.00', currency: 'USD' }),
        balanceBefore: brl('1.00'),
        balanceAfter: brl('2.00'),
      }),
    ).toThrow(InvariantViolationError);
  });

  test('is structurally immutable', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('1.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('1.00'),
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: Money }).balanceAfter = brl('999.00');
    }).toThrow();
  });

  test('rehydrate rebuilds a persisted line as is (its arithmetic was proven at creation and by the database)', () => {
    const state = {
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('5.00'),
      balanceBefore: brl('20.00'),
      balanceAfter: brl('15.00'),
    };
    const entry = WalletLedgerEntry.rehydrate(state);
    expect(entry.isBalanced()).toBe(true);
    expect(entry.signedAmount().amount).toBe('-5.00');
    expect(entry.createdAt).toEqual(base.createdAt);
    expect(Object.isFrozen(entry)).toBe(true);
    // No validation re-runs on load: create() would refuse this line, rehydrate() does not.
    const unbalanced = { ...state, balanceAfter: brl('14.00') };
    expect(() => WalletLedgerEntry.create(unbalanced)).toThrow(InvariantViolationError);
    expect(WalletLedgerEntry.rehydrate(unbalanced).isBalanced()).toBe(false);
  });
});
