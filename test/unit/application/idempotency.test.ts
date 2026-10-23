import { describe, expect, test } from 'bun:test';
import { idempotentOutcome } from '../../../src/application/use-cases/process-wager-transaction.use-case';
import {
  FailureCode,
  WagerTransactionKind as Kind,
} from '../../../src/domain/wagering/wager-transaction-types';
import { brl, HASH, NOW, processed, transaction } from '../domain/domain-builders';

const OTHER_HASH = 'b'.repeat(64);

describe('idempotency key already used', () => {
  test('same payload: the original result is replayed, including the balance observed back then', () => {
    const stored = processed(Kind.Bet, '25.00');
    const outcome = idempotentOutcome(stored, HASH);
    expect(outcome.type).toBe('REPLAY');
    expect(outcome.type === 'REPLAY' && outcome.transaction).toMatchObject({
      transactionId: stored.id,
      status: 'PROCESSED',
      balance: { amount: '0.00', currency: 'BRL' },
    });
  });

  test('same payload of a rejected operation: the rejection is replayed, not retried', () => {
    const stored = transaction(Kind.Bet, '80.00');
    stored.reject(FailureCode.InsufficientFunds, {
      at: NOW,
      result: { balance: brl('20.00'), walletVersion: 1 },
    });
    const outcome = idempotentOutcome(stored, HASH);
    expect(outcome.type === 'REPLAY' && outcome.transaction).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '20.00' },
    });
  });

  test('different payload: a conflict pointing at the existing transaction, never a replay', () => {
    const stored = processed(Kind.Bet, '25.00');
    expect(idempotentOutcome(stored, OTHER_HASH)).toEqual({
      type: 'CONFLICT',
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      existingTransactionId: stored.id,
    });
  });
});
