import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  DomainValidationError,
  InsufficientFundsError,
  InvariantViolationError,
  MoneyOverflowError,
} from '../../../src/domain/errors/domain-errors';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-direction';
import { Money } from '../../../src/domain/money/money';
import { Wallet } from '../../../src/domain/wallet/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-22T12:00:00.000Z');
let sequence = 0;
const movement = (amount: string) => ({
  money: brl(amount),
  transactionId: `tx-${++sequence}`,
  ledgerEntryId: `le-${sequence}`,
  at,
});

function open(initial: string): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initial),
    openedAt: at,
    opening: { transactionId: 'opening-tx', ledgerEntryId: 'opening-entry' },
  }).wallet;
}

describe('Wallet.open', () => {
  test('positive initial balance: version 1 and exactly one CREDIT entry 0 -> initial', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: brl('100.00'),
      openedAt: at,
      opening: { transactionId: 't', ledgerEntryId: 'e' },
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('100.00');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.amount).toBe('100.00');
    expect(openingEntry?.walletVersion).toBe(1);
  });

  test('zero initial balance creates no artificial ledger entry', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: brl('0.00'),
      openedAt: at,
    });
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('positive balance without OPENING ids is a programming error', () => {
    expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00'), openedAt: at })).toThrow(
      InvariantViolationError,
    );
  });

  test('requires ids', () => {
    expect(() => Wallet.open({ id: ' ', playerId: 'p', initialBalance: brl('0.00'), openedAt: at })).toThrow(
      DomainValidationError,
    );
  });
});

describe('Wallet movements', () => {
  test('debit decreases the balance, increments the version and returns the matching entry', () => {
    const wallet = open('100.00');
    const entry = wallet.debit(movement('80.00'));
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('20.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  test('credit increases the balance and the version', () => {
    const wallet = open('10.00');
    const entry = wallet.credit(movement('5.55'));
    expect(wallet.balance.amount).toBe('15.55');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('debit exactly to zero is allowed; one cent more is insufficient funds and changes nothing', () => {
    const wallet = open('10.00');
    expect(wallet.canDebit(brl('10.01'))).toBe(false);
    expect(() => wallet.debit(movement('10.01'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe('10.00');
    expect(wallet.version).toBe(1);
    wallet.debit(movement('10.00'));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('balance can never become negative', () => {
    const wallet = open('0.00');
    expect(() => wallet.debit(movement('0.01'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.isNegative()).toBe(false);
  });

  test('currency mismatch is rejected', () => {
    const wallet = open('10.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.credit({ ...movement('1.00'), money: usd })).toThrow(CurrencyMismatchError);
    expect(() => wallet.canDebit(usd)).toThrow(CurrencyMismatchError);
  });

  test('zero movements are rejected (version only changes with the balance)', () => {
    const wallet = open('10.00');
    expect(() => wallet.credit(movement('0.00'))).toThrow(DomainValidationError);
    expect(wallet.version).toBe(1);
  });

  test('an overflowing credit leaves the wallet untouched', () => {
    const wallet = open('999999999999999999.00');
    expect(() => wallet.credit(movement('1.00'))).toThrow(MoneyOverflowError);
    expect(wallet.balance.amount).toBe('999999999999999999.00');
    expect(wallet.version).toBe(1);
  });

  test('rehydrate restores persisted state without re-running rules', () => {
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 17,
      createdAt: at,
      updatedAt: at,
    });
    expect(wallet.version).toBe(17);
    expect(wallet.snapshot()).toEqual({ balance: brl('42.00'), walletVersion: 17 });
  });

  test('movements never go back in time, even with a lagging clock (skew between instances)', () => {
    const later = new Date(at.getTime() + 5_000);
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: brl('10.00'),
      version: 3,
      createdAt: at,
      updatedAt: later,
    });
    const entry = wallet.debit({ ...movement('1.00'), at }); // this instance's clock is 5s behind
    expect(entry.createdAt).toEqual(later);
    expect(wallet.updatedAt).toEqual(later);
    expect(wallet.updatedAt.getTime()).toBeGreaterThanOrEqual(wallet.createdAt.getTime());
  });
});
