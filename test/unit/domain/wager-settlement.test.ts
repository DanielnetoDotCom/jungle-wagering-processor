import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-direction';
import { ReferenceRetryPolicy } from '../../../src/domain/wagering/reference-retry-policy';
import {
  WagerSettlementService,
  type SettlementContext,
} from '../../../src/domain/wagering/wager-settlement.service';
import type { WagerTransaction } from '../../../src/domain/wagering/wager-transaction';
import {
  FailureCode,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../src/domain/wagering/wager-transaction-types';
import { brl, NOW, processed, transaction, wallet } from './domain-builders';

const policy = ReferenceRetryPolicy.create({
  initialDelayMs: 2_000,
  maxDelayMs: 300_000,
  multiplier: 2,
  maxAttempts: 3,
  ttlMs: 3_600_000,
});
const service = new WagerSettlementService(policy);

function context(overrides: Partial<SettlementContext> = {}): SettlementContext {
  return {
    reference: undefined,
    referenceAlreadyReversed: false,
    ledgerEntryId: 'entry-1',
    now: NOW,
    ...overrides,
  };
}

describe('BET', () => {
  test('debits the wallet with exactly one DEBIT entry', () => {
    const w = wallet('100.00');
    const bet = transaction(Kind.Bet, '80.00');
    const outcome = service.settle(bet, w, context());
    expect(outcome.type).toBe('PROCESSED');
    expect(outcome.type === 'PROCESSED' && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.amount).toBe('20.00');
    expect(w.version).toBe(2);
    expect(bet.status).toBe(Status.Processed);
    expect(bet.result?.balance.amount).toBe('20.00');
  });

  test('insufficient funds: REJECTED, no ledger, balance and version untouched', () => {
    const w = wallet('20.00');
    const bet = transaction(Kind.Bet, '80.00');
    const outcome = service.settle(bet, w, context());
    expect(outcome).toEqual({ type: 'REJECTED', code: FailureCode.InsufficientFunds });
    expect(bet.status).toBe(Status.Rejected);
    expect(bet.result?.balance.amount).toBe('20.00');
    expect(w.balance.amount).toBe('20.00');
    expect(w.version).toBe(1);
  });

  test('currency and player mismatches are business rejections', () => {
    const usdBet = transaction(Kind.Bet, '1.00', { currency: 'USD' });
    expect(service.settle(usdBet, wallet('10.00'), context())).toEqual({
      type: 'REJECTED',
      code: FailureCode.CurrencyMismatch,
    });
    const strangerBet = transaction(Kind.Bet, '1.00', { playerId: 'someone-else' });
    expect(service.settle(strangerBet, wallet('10.00'), context())).toEqual({
      type: 'REJECTED',
      code: FailureCode.PlayerWalletMismatch,
    });
  });
});

describe('WIN and LOSS', () => {
  test('WIN credits with one CREDIT entry; with a reference it must be a processed BET of the round', () => {
    const w = wallet('10.00');
    const bet = processed(Kind.Bet, '5.00', { externalTransactionId: 'bet-1' });
    const win = transaction(Kind.Win, '12.50', { reference: 'bet-1' });
    const outcome = service.settle(win, w, context({ reference: bet }));
    expect(outcome.type === 'PROCESSED' && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.amount).toBe('22.50');
    expect(win.referenceTransactionId).toBe(bet.id);
  });

  test('LOSS is PROCESSED without ledger, balance or version change', () => {
    const w = wallet('10.00');
    const loss = transaction(Kind.Loss, '0.00');
    const outcome = service.settle(loss, w, context());
    expect(outcome).toEqual({ type: 'PROCESSED', ledgerEntry: undefined, reference: undefined });
    expect(loss.status).toBe(Status.Processed);
    expect(w.balance.amount).toBe('10.00');
    expect(w.version).toBe(1);
  });

  test('a credit that would overflow NUMERIC(20,2) is rejected, not truncated', () => {
    const w = wallet('999999999999999999.00');
    const win = transaction(Kind.Win, '1.00');
    expect(service.settle(win, w, context())).toEqual({
      type: 'REJECTED',
      code: FailureCode.BalanceLimitExceeded,
    });
    expect(w.version).toBe(1);
  });
});

describe('REFUND', () => {
  test('credits the original BET amount', () => {
    const w = wallet('20.00');
    const bet = processed(Kind.Bet, '80.00', { externalTransactionId: 'bet-1' });
    const refund = transaction(Kind.Refund, '80.00', { reference: 'bet-1' });
    const outcome = service.settle(refund, w, context({ reference: bet }));
    expect(outcome.type).toBe('PROCESSED');
    expect(w.balance.amount).toBe('100.00');
  });

  test('only BET can be refunded', () => {
    const win = processed(Kind.Win, '10.00', { externalTransactionId: 'win-1' });
    const refund = transaction(Kind.Refund, '10.00', { reference: 'win-1' });
    expect(service.settle(refund, wallet('5.00'), context({ reference: win }))).toEqual({
      type: 'REJECTED',
      code: FailureCode.ReferenceKindNotAllowed,
    });
  });

  test('partial refunds are rejected', () => {
    const bet = processed(Kind.Bet, '80.00', { externalTransactionId: 'bet-1' });
    const refund = transaction(Kind.Refund, '40.00', { reference: 'bet-1' });
    expect(service.settle(refund, wallet('5.00'), context({ reference: bet }))).toEqual({
      type: 'REJECTED',
      code: FailureCode.ReversalAmountMismatch,
    });
  });

  test('reference of another round / player / wallet is a mismatch', () => {
    const bet = processed(Kind.Bet, '10.00', { externalTransactionId: 'bet-1', roundId: 'round-9' });
    const refund = transaction(Kind.Refund, '10.00', { reference: 'bet-1', roundId: 'round-1' });
    expect(service.settle(refund, wallet('5.00'), context({ reference: bet }))).toEqual({
      type: 'REJECTED',
      code: FailureCode.ReferenceMismatch,
    });
  });

  test('a REJECTED reference cannot be refunded', () => {
    const bet = transaction(Kind.Bet, '10.00', { externalTransactionId: 'bet-1' });
    bet.reject(FailureCode.InsufficientFunds, {
      at: NOW,
      result: { balance: brl('0.00'), walletVersion: 1 },
    });
    const refund = transaction(Kind.Refund, '10.00', { reference: 'bet-1' });
    expect(service.settle(refund, wallet('5.00'), context({ reference: bet }))).toEqual({
      type: 'REJECTED',
      code: FailureCode.ReferenceNotProcessed,
    });
  });

  test('a second successful reversal of the same BET is refused, whatever its kind', () => {
    const bet = processed(Kind.Bet, '10.00', { externalTransactionId: 'bet-1' });
    const refund = transaction(Kind.Refund, '10.00', { reference: 'bet-1' });
    expect(
      service.settle(refund, wallet('5.00'), context({ reference: bet, referenceAlreadyReversed: true })),
    ).toEqual({
      type: 'REJECTED',
      code: FailureCode.ReferenceAlreadyReversed,
    });
    const rollback = transaction(Kind.Rollback, '10.00', { reference: 'bet-1' });
    expect(
      service.settle(rollback, wallet('5.00'), context({ reference: bet, referenceAlreadyReversed: true })),
    ).toEqual({
      type: 'REJECTED',
      code: FailureCode.ReferenceAlreadyReversed,
    });
  });
});

describe('ROLLBACK', () => {
  test('of a BET credits it back', () => {
    const w = wallet('20.00');
    const bet = processed(Kind.Bet, '80.00', { externalTransactionId: 'bet-1' });
    const rollback = transaction(Kind.Rollback, '80.00', { reference: 'bet-1' });
    const outcome = service.settle(rollback, w, context({ reference: bet }));
    expect(outcome.type === 'PROCESSED' && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.amount).toBe('100.00');
  });

  test('of a WIN debits it back', () => {
    const w = wallet('150.00');
    const win = processed(Kind.Win, '50.00', { externalTransactionId: 'win-1' });
    const rollback = transaction(Kind.Rollback, '50.00', { reference: 'win-1' });
    const outcome = service.settle(rollback, w, context({ reference: win }));
    expect(outcome.type === 'PROCESSED' && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.amount).toBe('100.00');
  });

  test('of a REFUND is a separate compensating debit', () => {
    const w = wallet('100.00');
    const refund = processed(Kind.Refund, '80.00', { externalTransactionId: 'refund-1', reference: 'bet-1' });
    const rollback = transaction(Kind.Rollback, '80.00', { reference: 'refund-1' });
    const outcome = service.settle(rollback, w, context({ reference: refund }));
    expect(outcome.type).toBe('PROCESSED');
    expect(w.balance.amount).toBe('20.00');
  });

  test('a reversal debit that would go negative is rejected with its own code (not INSUFFICIENT_FUNDS)', () => {
    const w = wallet('10.00');
    const win = processed(Kind.Win, '50.00', { externalTransactionId: 'win-1' });
    const rollback = transaction(Kind.Rollback, '50.00', { reference: 'win-1' });
    expect(service.settle(rollback, w, context({ reference: win }))).toEqual({
      type: 'REJECTED',
      code: FailureCode.ReversalInsufficientFunds,
    });
    expect(w.balance.amount).toBe('10.00');
    expect(rollback.status).toBe(Status.Rejected);
  });

  test('ROLLBACK of a ROLLBACK or of a LOSS is not allowed', () => {
    const loss = processed(Kind.Loss, '0.00', { externalTransactionId: 'loss-1' });
    const ofLoss = transaction(Kind.Rollback, '0.01', { reference: 'loss-1' });
    expect(service.settle(ofLoss, wallet('5.00'), context({ reference: loss }))).toEqual({
      type: 'REJECTED',
      code: FailureCode.ReferenceKindNotAllowed,
    });

    const w = wallet('100.00');
    const rolledBack = processed(Kind.Rollback, '80.00', {
      externalTransactionId: 'rb-1',
      reference: 'bet-1',
    });
    const ofRollback = transaction(Kind.Rollback, '80.00', { reference: 'rb-1' });
    expect(service.settle(ofRollback, w, context({ reference: rolledBack }))).toEqual({
      type: 'REJECTED',
      code: FailureCode.ReferenceKindNotAllowed,
    });
    expect(w.balance.amount).toBe('100.00');
    expect(w.version).toBe(1);
  });
});

describe('Out-of-order references', () => {
  function pendingRefund(): WagerTransaction {
    const refund = transaction(Kind.Refund, '10.00', { reference: 'bet-late' });
    expect(service.settle(refund, wallet('5.00'), context())).toEqual({ type: 'PENDING_REFERENCE' });
    return refund;
  }

  test('missing reference -> PENDING_REFERENCE, nothing moves, first attempt after the initial backoff', () => {
    const w = wallet('5.00');
    const refund = transaction(Kind.Refund, '10.00', { reference: 'bet-late' });
    expect(service.settle(refund, w, context())).toEqual({ type: 'PENDING_REFERENCE' });
    expect(refund.status).toBe(Status.PendingReference);
    expect(refund.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 2_000);
    expect(refund.referenceExpiresAt?.getTime()).toBe(NOW.getTime() + 3_600_000);
    expect(w.balance.amount).toBe('5.00');
    expect(w.version).toBe(1);
  });

  test('a reference that is itself still pending keeps the dependent waiting', () => {
    const pendingReference = pendingRefund();
    const rollback = transaction(Kind.Rollback, '10.00', {
      reference: pendingReference.externalTransactionId,
    });
    expect(service.settle(rollback, wallet('5.00'), context({ reference: pendingReference }))).toEqual({
      type: 'PENDING_REFERENCE',
    });
  });

  test('worker attempts back off exponentially and end as REFERENCE_NOT_FOUND after maxAttempts', () => {
    const refund = pendingRefund();
    const w = wallet('5.00');
    const first = service.settle(refund, w, context({ now: new Date(NOW.getTime() + 2_000) }));
    expect(first.type).toBe('REFERENCE_RETRY_SCHEDULED');
    expect(refund.referenceAttempts).toBe(1);
    expect(refund.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 2_000 + 4_000);

    const second = service.settle(refund, w, context({ now: new Date(NOW.getTime() + 6_000) }));
    expect(second.type).toBe('REFERENCE_RETRY_SCHEDULED');
    expect(refund.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 6_000 + 8_000);

    const third = service.settle(refund, w, context({ now: new Date(NOW.getTime() + 14_000) }));
    expect(third).toEqual({ type: 'REJECTED', code: FailureCode.ReferenceNotFound });
    expect(refund.referenceAttempts).toBe(3);
    expect(refund.status).toBe(Status.Rejected);
    expect(w.version).toBe(1);
  });

  test('TTL expiry rejects even before maxAttempts', () => {
    const refund = pendingRefund();
    const outcome = service.settle(
      refund,
      wallet('5.00'),
      context({ now: new Date(NOW.getTime() + 3_600_000) }),
    );
    expect(outcome).toEqual({ type: 'REJECTED', code: FailureCode.ReferenceNotFound });
  });

  test('when the reference appears, the same rules apply (REFUND processed)', () => {
    const refund = pendingRefund();
    const w = wallet('5.00');
    const bet = processed(Kind.Bet, '10.00', { externalTransactionId: 'bet-late' });
    const outcome = service.settle(
      refund,
      w,
      context({ reference: bet, now: new Date(NOW.getTime() + 2_000) }),
    );
    expect(outcome.type).toBe('PROCESSED');
    expect(w.balance.amount).toBe('15.00');
    expect(refund.referenceAttempts).toBe(1);
  });

  test('repeated unexpected failures end as FAILED (auditable, terminal)', () => {
    const refund = pendingRefund();
    const w = wallet('5.00');
    expect(service.recordResolutionFailure(refund, w, NOW).type).toBe('REFERENCE_RETRY_SCHEDULED');
    expect(service.recordResolutionFailure(refund, w, NOW).type).toBe('REFERENCE_RETRY_SCHEDULED');
    expect(service.recordResolutionFailure(refund, w, NOW)).toEqual({
      type: 'FAILED',
      code: FailureCode.ReferenceResolutionFailed,
    });
    expect(refund.status).toBe(Status.Failed);
  });
});

describe('ReferenceRetryPolicy', () => {
  test('2s, 4s, 8s ... capped at the maximum delay', () => {
    const capped = ReferenceRetryPolicy.create({
      initialDelayMs: 2000,
      maxDelayMs: 300_000,
      multiplier: 2,
      maxAttempts: 10,
      ttlMs: 3_600_000,
    });
    expect([0, 1, 2, 3, 7, 8, 9].map((attempts) => capped.delayAfter(attempts))).toEqual([
      2000, 4000, 8000, 16000, 256000, 300000, 300000,
    ]);
  });
});
