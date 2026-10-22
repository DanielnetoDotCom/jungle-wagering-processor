import { describe, expect, test } from 'bun:test';
import { wagerPayloadHash } from '../../../src/application/services/payload-hash';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-transaction-types';
import { canonicalJson } from '../../../src/shared/canonical-json';

const base = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: WagerTransactionKind.Bet,
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonical JSON', () => {
  test('sorts keys recursively, omits undefined, no whitespace', () => {
    expect(canonicalJson({ b: '2', a: { d: null, c: true }, e: undefined, f: ['x', 'y'] })).toBe(
      '{"a":{"c":true,"d":null},"b":"2","f":["x","y"]}',
    );
  });

  test('escapes strings exactly like JSON', () => {
    expect(canonicalJson({ k: 'quote " and \\ and \n' })).toBe('{"k":"quote \\" and \\\\ and \\n"}');
  });
});

describe('payloadHash', () => {
  test('is a stable, documented SHA-256 of the canonical business fields', () => {
    // Test vector: changing the algorithm breaks every stored idempotency record.
    expect(wagerPayloadHash(base)).toBe(
      new Bun.CryptoHasher('sha256')
        .update(
          '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}',
        )
        .digest('hex'),
    );
  });

  test('property order does not matter', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: WagerTransactionKind.Bet,
      gameId: base.gameId,
      roundId: base.roundId,
      walletId: base.walletId,
      playerId: base.playerId,
      externalTransactionId: base.externalTransactionId,
      providerId: base.providerId,
    };
    expect(wagerPayloadHash(reordered)).toBe(wagerPayloadHash(base));
  });

  test('transport metadata is excluded: the SQS idempotencyKey does not change the hash', () => {
    const fromSqs = { ...base, idempotencyKey: 'provider-a:transaction-123' } as typeof base;
    expect(wagerPayloadHash(fromSqs)).toBe(wagerPayloadHash(base));
  });

  test('any business change changes the hash', () => {
    const original = wagerPayloadHash(base);
    expect(wagerPayloadHash({ ...base, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(original);
    expect(wagerPayloadHash({ ...base, kind: WagerTransactionKind.Win })).not.toBe(original);
    expect(wagerPayloadHash({ ...base, roundId: 'round-988' })).not.toBe(original);
    expect(wagerPayloadHash({ ...base, referenceExternalTransactionId: 'x' })).not.toBe(original);
  });

  test('an absent optional reference hashes like an omitted one', () => {
    expect(wagerPayloadHash({ ...base, referenceExternalTransactionId: undefined })).toBe(
      wagerPayloadHash(base),
    );
  });
});
