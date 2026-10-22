import { createHash } from 'node:crypto';
import { Money } from '../../domain/money/money';
import { canonicalJson } from '../../shared/canonical-json';
import type { WagerTransactionPayload } from '../commands/wager-commands';

/**
 * payloadHash = lowercase hex SHA-256 of the canonical JSON of the business
 * fields only:
 *
 *   providerId, externalTransactionId, playerId, walletId, roundId, gameId,
 *   kind, money{amount,currency}, referenceExternalTransactionId (when present)
 *
 * Canonical JSON = keys sorted, no whitespace, absent optionals omitted, money
 * normalised through `Money` (scale 2). The Idempotency-Key header, the SQS
 * envelope (messageId, occurredAt, type) and any transport metadata are NOT
 * part of the hash, so the same operation hashes identically over HTTP and SQS.
 */
export function wagerPayloadHash(payload: WagerTransactionPayload): string {
  const money = Money.from(payload.money);
  const canonical = canonicalJson({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: money.amount, currency: money.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  });
  return sha256Hex(canonical);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
