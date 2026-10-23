import { describe, expect, test } from 'bun:test';
import {
  DomainValidationError,
  InvalidTransactionStateError,
  InvariantViolationError,
} from '../../../src/domain/errors/domain-errors';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-direction';
import { WagerTransaction } from '../../../src/domain/wagering/wager-transaction';
import {
  FailureCode,
  TransactionChannel,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../src/domain/wagering/wager-transaction-types';
import { brl, HASH, NOW, processed, transaction } from './domain-builders';

const result = { balance: brl('10.00'), walletVersion: 3 };

describe('WagerTransaction.create', () => {
  test('is born PENDING with its immutable identity', () => {
    const tx = transaction(Kind.Bet, '25.00', { externalTransactionId: 'ext-1' });
    expect(tx.status).toBe(Status.Pending);
    expect(tx.externalTransactionId).toBe('ext-1');
    expect(tx.isTerminal()).toBe(false);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s requires a reference', (kind) => {
    expect(() => transaction(kind, '10.00')).toThrow(DomainValidationError);
  });

  test('BET cannot carry a reference; WIN and LOSS may', () => {
    expect(() => transaction(Kind.Bet, '10.00', { reference: 'x' })).toThrow(DomainValidationError);
    expect(transaction(Kind.Win, '10.00', { reference: 'x' }).hasReference()).toBe(true);
    expect(transaction(Kind.Loss, '0.00', { reference: 'x' }).hasReference()).toBe(true);
  });

  test('a transaction cannot reference itself', () => {
    expect(() =>
      transaction(Kind.Refund, '1.00', { externalTransactionId: 'same', reference: 'same' }),
    ).toThrow(DomainValidationError);
  });

  test('only LOSS may have a zero amount', () => {
    expect(() => transaction(Kind.Bet, '0.00')).toThrow(DomainValidationError);
    expect(() => transaction(Kind.Win, '0.00')).toThrow(DomainValidationError);
    expect(transaction(Kind.Loss, '0.00').money.isZero()).toBe(true);
  });

  test('OPENING is internal only and the internal channel only creates OPENING', () => {
    const base = {
      id: 'id',
      providerId: 'internal',
      externalTransactionId: 'e',
      idempotencyKey: 'k',
      payloadHash: HASH,
      walletId: 'w',
      playerId: 'p',
      roundId: undefined,
      gameId: undefined,
      money: brl('1.00'),
      referenceExternalTransactionId: undefined,
      createdAt: NOW,
    };
    expect(() =>
      WagerTransaction.create({ ...base, kind: Kind.Opening, channel: TransactionChannel.Http }),
    ).toThrow(DomainValidationError);
    expect(() =>
      WagerTransaction.create({ ...base, kind: Kind.Opening, channel: TransactionChannel.Sqs }),
    ).toThrow(DomainValidationError);
    expect(() =>
      WagerTransaction.create({
        ...base,
        kind: Kind.Bet,
        roundId: 'r',
        gameId: 'g',
        channel: TransactionChannel.Internal,
      }),
    ).toThrow(DomainValidationError);
    expect(
      WagerTransaction.create({ ...base, kind: Kind.Opening, channel: TransactionChannel.Internal }).kind,
    ).toBe(Kind.Opening);
  });

  test('the internal provider id is reserved to the internal channel', () => {
    const base = {
      id: 'id',
      externalTransactionId: 'e',
      idempotencyKey: 'k',
      payloadHash: HASH,
      walletId: 'w',
      playerId: 'p',
      roundId: 'r',
      gameId: 'g',
      money: brl('1.00'),
      referenceExternalTransactionId: undefined,
      createdAt: NOW,
    };
    for (const channel of [TransactionChannel.Http, TransactionChannel.Sqs]) {
      expect(() =>
        WagerTransaction.create({ ...base, providerId: 'internal', kind: Kind.Bet, channel }),
      ).toThrow(DomainValidationError);
    }
    expect(() =>
      WagerTransaction.create({
        ...base,
        providerId: 'provider-a',
        kind: Kind.Opening,
        roundId: undefined,
        gameId: undefined,
        channel: TransactionChannel.Internal,
      }),
    ).toThrow(DomainValidationError);
  });

  test('payload hash must be a SHA-256 hex digest', () => {
    expect(() =>
      WagerTransaction.create({
        id: 'id',
        providerId: 'p',
        externalTransactionId: 'e',
        idempotencyKey: 'k',
        payloadHash: 'not-a-hash',
        channel: TransactionChannel.Http,
        walletId: 'w',
        playerId: 'p',
        roundId: 'r',
        gameId: 'g',
        kind: Kind.Bet,
        money: brl('1.00'),
        referenceExternalTransactionId: undefined,
        createdAt: NOW,
      }),
    ).toThrow(DomainValidationError);
  });

  test('matchesPayload compares hashes', () => {
    const tx = transaction(Kind.Bet, '1.00');
    expect(tx.matchesPayload(HASH)).toBe(true);
    expect(tx.matchesPayload('b'.repeat(64))).toBe(false);
  });
});

describe('WagerTransaction state machine', () => {
  test('PENDING -> PROCESSED is terminal: no further transition is possible', () => {
    const tx = transaction(Kind.Bet, '10.00');
    tx.markProcessed({ referenceTransactionId: undefined, at: NOW, result });
    expect(tx.status).toBe(Status.Processed);
    expect(tx.processedAt).toEqual(NOW);
    expect(tx.result).toEqual(result);
    expect(() => tx.markProcessed({ referenceTransactionId: undefined, at: NOW, result })).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.reject(FailureCode.InsufficientFunds, { at: NOW, result })).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.fail(FailureCode.ReferenceResolutionFailed, { at: NOW, result })).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('REJECTED and FAILED are terminal too', () => {
    const rejected = transaction(Kind.Bet, '10.00');
    rejected.reject(FailureCode.InsufficientFunds, { at: NOW, result });
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(() => rejected.markProcessed({ referenceTransactionId: undefined, at: NOW, result })).toThrow(
      InvalidTransactionStateError,
    );

    const failed = transaction(Kind.Refund, '10.00', { reference: 'r' });
    failed.fail(FailureCode.ReferenceResolutionFailed, { at: NOW, result });
    expect(failed.status).toBe(Status.Failed);
    expect(() => failed.reject(FailureCode.ReferenceNotFound, { at: NOW, result })).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('PENDING_REFERENCE: retries keep the status; settlement leaves it', () => {
    const tx = transaction(Kind.Refund, '10.00', { reference: 'bet-1' });
    tx.markPendingReference({
      at: NOW,
      nextAttemptAt: new Date(NOW.getTime() + 2000),
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      result,
    });
    expect(tx.status).toBe(Status.PendingReference);
    tx.registerReferenceAttempt(NOW);
    tx.scheduleReferenceRetry({ at: NOW, nextAttemptAt: new Date(NOW.getTime() + 4000) });
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.status).toBe(Status.PendingReference);
    tx.markProcessed({ referenceTransactionId: 'bet-internal-id', at: NOW, result });
    expect(tx.status).toBe(Status.Processed);
    expect(tx.nextAttemptAt).toBeUndefined();
    expect(() => tx.registerReferenceAttempt(NOW)).toThrow(InvalidTransactionStateError);
  });

  test('only transactions with a reference can wait for one, and cannot go back to waiting', () => {
    const bet = transaction(Kind.Bet, '10.00');
    expect(() => bet.markPendingReference({ at: NOW, nextAttemptAt: NOW, expiresAt: NOW, result })).toThrow(
      InvariantViolationError,
    );
    const refund = transaction(Kind.Refund, '10.00', { reference: 'x' });
    refund.markPendingReference({ at: NOW, nextAttemptAt: NOW, expiresAt: NOW, result });
    expect(() =>
      refund.markPendingReference({ at: NOW, nextAttemptAt: NOW, expiresAt: NOW, result }),
    ).toThrow(InvalidTransactionStateError);
  });

  test('a referenced transaction must be processed against its resolved reference', () => {
    const refund = transaction(Kind.Refund, '10.00', { reference: 'x' });
    expect(() => refund.markProcessed({ referenceTransactionId: undefined, at: NOW, result })).toThrow(
      InvariantViolationError,
    );
    const bet = transaction(Kind.Bet, '10.00');
    expect(() => bet.markProcessed({ referenceTransactionId: 'y', at: NOW, result })).toThrow(
      InvariantViolationError,
    );
  });
});

describe('WagerTransaction domain queries', () => {
  test('ledger direction per kind; ROLLBACK inverts its reference', () => {
    expect(transaction(Kind.Bet, '1.00').ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(transaction(Kind.Win, '1.00').ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(transaction(Kind.Refund, '1.00', { reference: 'r' }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
    const rollback = transaction(Kind.Rollback, '1.00', { reference: 'r' });
    expect(rollback.ledgerDirectionFor(processed(Kind.Bet, '1.00'))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(processed(Kind.Win, '1.00'))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(processed(Kind.Refund, '1.00', { reference: 'b' }))).toBe(
      LedgerDirection.Debit,
    );
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvariantViolationError);
    expect(() => transaction(Kind.Loss, '0.00').ledgerDirectionFor()).toThrow(InvariantViolationError);
  });

  test('LOSS does not affect the balance; REFUND/ROLLBACK require references', () => {
    expect(transaction(Kind.Loss, '0.00').affectsBalance()).toBe(false);
    expect(transaction(Kind.Bet, '1.00').affectsBalance()).toBe(true);
    expect(transaction(Kind.Refund, '1.00', { reference: 'r' }).requiresReference()).toBe(true);
    expect(transaction(Kind.Win, '1.00').requiresReference()).toBe(false);
  });

  test('allowed reference kinds', () => {
    const refund = transaction(Kind.Refund, '1.00', { reference: 'r' });
    expect(refund.canReference(Kind.Bet)).toBe(true);
    expect(refund.canReference(Kind.Win)).toBe(false);
    const rollback = transaction(Kind.Rollback, '1.00', { reference: 'r' });
    expect([Kind.Bet, Kind.Win, Kind.Refund].every((kind) => rollback.canReference(kind))).toBe(true);
    expect(rollback.canReference(Kind.Rollback)).toBe(false);
    expect(rollback.canReference(Kind.Loss)).toBe(false);
  });

  test('referenceMismatches lists every differing attribute', () => {
    const reference = processed(Kind.Bet, '1.00', { externalTransactionId: 'bet-1', roundId: 'round-1' });
    const refund = transaction(Kind.Refund, '1.00', {
      reference: 'bet-1',
      roundId: 'round-2',
      playerId: 'other',
    });
    expect(refund.referenceMismatches(reference).sort()).toEqual(['playerId', 'roundId']);
    const elsewhere = transaction(Kind.Refund, '1.00', {
      reference: 'bet-1',
      providerId: 'provider-b',
      walletId: 'wallet-2',
      currency: 'USD',
    });
    expect(elsewhere.referenceMismatches(reference).sort()).toEqual(['currency', 'providerId', 'walletId']);
    const ok = transaction(Kind.Refund, '1.00', { reference: 'bet-1' });
    expect(ok.referenceMismatches(reference)).toEqual([]);
  });

  test('rehydrate trusts persisted state: no create validation and no transition re-run', () => {
    const original = processed(Kind.Bet, '25.00', { externalTransactionId: 'bet-1' });
    const state = {
      id: original.id,
      providerId: original.providerId,
      externalTransactionId: original.externalTransactionId,
      idempotencyKey: original.idempotencyKey,
      payloadHash: HASH,
      channel: TransactionChannel.Http,
      walletId: original.walletId,
      playerId: original.playerId,
      roundId: original.roundId,
      gameId: original.gameId,
      kind: original.kind,
      money: original.money,
      referenceExternalTransactionId: undefined,
      createdAt: NOW,
      status: Status.Processed,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: NOW,
      result: original.result,
      referenceAttempts: 0,
      nextAttemptAt: undefined,
      referenceExpiresAt: undefined,
      updatedAt: NOW,
    };
    const restored = WagerTransaction.rehydrate(state);
    expect(restored.status).toBe(Status.Processed);
    expect(restored.isTerminal()).toBe(true);
    expect(restored.result?.balance.amount).toBe(original.result?.balance.amount);
    // A legacy row that today's create() would refuse (blank round) still loads.
    expect(WagerTransaction.rehydrate({ ...state, roundId: undefined }).roundId).toBeUndefined();
    // Terminal state loaded from the database still refuses every transition.
    expect(() =>
      restored.reject(FailureCode.InsufficientFunds, { at: NOW, result: original.result! }),
    ).toThrow(InvalidTransactionStateError);
  });
});
