import { describe, expect, test } from 'bun:test';
import {
  ConflictError,
  ErrorCategory,
  IntegrityViolationError,
  RequestValidationError,
  ResourceNotFoundError,
  TransientInfrastructureError,
} from '../../../src/application/errors/application-errors';
import { InvalidMoneyError, InvariantViolationError } from '../../../src/domain/errors/domain-errors';
import {
  createWalletRequestSchema,
  wagerTransactionRequestedMessageSchema,
  wagerTransactionRequestSchema,
} from '../../../src/interfaces/contracts/wager-contracts';
import { STATUS_BY_CATEGORY, toHttpError } from '../../../src/interfaces/http/support/http-errors';
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
} from '../../../src/interfaces/http/presenters/ledger-cursor';

const valid = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('HTTP wager contract', () => {
  test('accepts the README example', () => {
    expect(wagerTransactionRequestSchema.safeParse(valid).success).toBe(true);
  });

  test.each([
    ['OPENING is internal only', { ...valid, kind: 'OPENING' }],
    ['unknown kind', { ...valid, kind: 'JACKPOT' }],
    ['unknown field (strict contract)', { ...valid, bonus: true }],
    ['amount as number', { ...valid, money: { amount: 25, currency: 'BRL' } }],
    ['amount with 3 decimals', { ...valid, money: { amount: '25.000', currency: 'BRL' } }],
    ['negative amount', { ...valid, money: { amount: '-25.00', currency: 'BRL' } }],
    ['scientific notation', { ...valid, money: { amount: '2.5e1', currency: 'BRL' } }],
    ['lowercase currency', { ...valid, money: { amount: '25.00', currency: 'brl' } }],
    ['walletId not a UUID', { ...valid, walletId: 'wallet-1' }],
    ['REFUND without reference', { ...valid, kind: 'REFUND' }],
    ['ROLLBACK without reference', { ...valid, kind: 'ROLLBACK' }],
    ['BET with reference', { ...valid, referenceExternalTransactionId: 'x' }],
    [
      'self reference',
      { ...valid, kind: 'REFUND', referenceExternalTransactionId: valid.externalTransactionId },
    ],
    ['zero BET', { ...valid, money: { amount: '0.00', currency: 'BRL' } }],
    ['blank providerId', { ...valid, providerId: '' }],
    ['reserved internal providerId', { ...valid, providerId: 'internal' }],
    ['identifier with spaces', { ...valid, roundId: 'round 1' }],
  ])('rejects: %s', (_label, body) => {
    expect(wagerTransactionRequestSchema.safeParse(body).success).toBe(false);
  });

  test('LOSS may be zero', () => {
    expect(
      wagerTransactionRequestSchema.safeParse({
        ...valid,
        kind: 'LOSS',
        money: { amount: '0.00', currency: 'BRL' },
      }).success,
    ).toBe(true);
  });
});

describe('SQS message contract', () => {
  const message = {
    messageId: 'msg-123',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data: { ...valid, idempotencyKey: 'provider-a:transaction-123' },
  };

  test('accepts the README example', () => {
    expect(wagerTransactionRequestedMessageSchema.safeParse(message).success).toBe(true);
  });

  test('rejects a wrong type, missing idempotency key or unknown data fields', () => {
    expect(wagerTransactionRequestedMessageSchema.safeParse({ ...message, type: 'Other' }).success).toBe(
      false,
    );
    const { idempotencyKey: _removed, ...withoutKey } = message.data;
    expect(wagerTransactionRequestedMessageSchema.safeParse({ ...message, data: withoutKey }).success).toBe(
      false,
    );
    expect(
      wagerTransactionRequestedMessageSchema.safeParse({ ...message, data: { ...message.data, extra: 1 } })
        .success,
    ).toBe(false);
    expect(
      wagerTransactionRequestedMessageSchema.safeParse({
        ...message,
        data: { ...message.data, kind: 'OPENING' },
      }).success,
    ).toBe(false);
    expect(
      wagerTransactionRequestedMessageSchema.safeParse({
        ...message,
        data: { ...message.data, providerId: 'internal' },
      }).success,
    ).toBe(false);
  });

  test('wallet creation contract', () => {
    expect(
      createWalletRequestSchema.safeParse({ playerId: valid.playerId, initialBalance: valid.money }).success,
    ).toBe(true);
    expect(
      createWalletRequestSchema.safeParse({
        playerId: valid.playerId,
        initialBalance: { amount: '1', currency: 'BRL' },
      }).success,
    ).toBe(false);
  });
});

describe('HTTP error mapping (consistent across endpoints)', () => {
  test('category -> status', () => {
    expect(STATUS_BY_CATEGORY).toEqual({
      [ErrorCategory.Validation]: 400,
      [ErrorCategory.Forbidden]: 403,
      [ErrorCategory.NotFound]: 404,
      [ErrorCategory.Conflict]: 409,
      [ErrorCategory.BusinessRule]: 422,
      [ErrorCategory.Transient]: 503,
      [ErrorCategory.Internal]: 500,
    });
  });

  test('each error exposes code + retryable, never internals', () => {
    expect(toHttpError(new RequestValidationError('bad', []), 'c').body).toMatchObject({
      code: 'VALIDATION_ERROR',
      retryable: false,
    });
    expect(toHttpError(new ResourceNotFoundError('WALLET_NOT_FOUND', 'x'), 'c').status).toBe(404);
    expect(toHttpError(new ConflictError('IDEMPOTENCY_KEY_CONFLICT', 'x'), 'c').status).toBe(409);
    const transient = toHttpError(new TransientInfrastructureError('DATABASE_UNAVAILABLE', 'down'), 'c');
    expect(transient).toMatchObject({ status: 503, body: { retryable: true, code: 'DATABASE_UNAVAILABLE' } });
    const integrity = toHttpError(
      new IntegrityViolationError('ledger_chain', 'SQL detail with internals'),
      'c',
    );
    expect(integrity.status).toBe(500);
    expect(integrity.body.message).not.toContain('SQL');
    expect(toHttpError(new InvalidMoneyError('bad amount'), 'c')).toMatchObject({
      status: 400,
      body: { code: 'INVALID_MONEY' },
    });
    expect(toHttpError(new InvariantViolationError('bug'), 'c')).toMatchObject({
      status: 500,
      body: { code: 'INTERNAL_ERROR' },
    });
    expect(toHttpError(new Error('boom'), 'c').body).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Unexpected error; the operation was not applied',
      correlationId: 'c',
      retryable: false,
    });
  });
});

describe('Ledger cursor', () => {
  test('round-trips and is bound to its wallet', () => {
    const cursor = encodeLedgerCursor('wallet-a', { order: 'desc', afterVersion: 42 });
    expect(decodeLedgerCursor('wallet-a', cursor)).toEqual({ order: 'desc', afterVersion: 42 });
    expect(() => decodeLedgerCursor('wallet-b', cursor)).toThrow(RequestValidationError);
    expect(() => decodeLedgerCursor('wallet-a', 'garbage')).toThrow(RequestValidationError);
  });
});
