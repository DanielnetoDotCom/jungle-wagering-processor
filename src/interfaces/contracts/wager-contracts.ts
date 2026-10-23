import { z } from 'zod';
import { INTERNAL_PROVIDER_ID, WagerTransactionKind } from '../../domain/wagering/wager-transaction-types';

/*
 * Wire contracts shared by HTTP and SQS. Strict objects: unknown fields are
 * rejected, because silently ignoring a field of a financial payload hides
 * contract drift between provider and platform.
 */

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * UUIDs are accepted in any letter case and normalised to lowercase (the form
 * PostgreSQL returns), so "0190ABCD-…" and "0190abcd-…" are the same wallet
 * and hash to the same payload.
 */
function canonicalUuid() {
  return z.uuid().transform((value) => value.toLowerCase());
}

export const identifier = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(
      IDENTIFIER,
      'must start with a letter or digit and contain only letters, digits, ".", "_", ":" or "-"',
    );

export const moneySchema = z.strictObject({
  amount: z
    .string()
    .regex(
      /^(0|[1-9]\d{0,17})\.\d{2}$/,
      'must be a non-negative decimal string with exactly 2 decimal places, e.g. "25.00"',
    ),
  currency: z.string().regex(/^[A-Z]{3}$/, 'must be an ISO-4217 currency code'),
});

/** Printable ASCII, no spaces. Recommended format: "{providerId}:{externalTransactionId}". */
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7E]+$/, 'must be 1-255 printable ASCII characters without spaces');

/** OPENING is internal: it is not part of the accepted kinds. */
const providerKind = z.enum([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const wagerPayloadShape = {
  providerId: identifier(64).refine((value) => value !== INTERNAL_PROVIDER_ID, {
    message: `"${INTERNAL_PROVIDER_ID}" is reserved for internal transactions`,
  }),
  externalTransactionId: identifier(128),
  playerId: identifier(128),
  walletId: canonicalUuid(),
  roundId: identifier(128),
  gameId: identifier(128),
  kind: providerKind,
  money: moneySchema,
  referenceExternalTransactionId: identifier(128).optional(),
};

type WagerPayloadInput = z.infer<z.ZodObject<typeof wagerPayloadShape>>;

function wagerRules(value: WagerPayloadInput, ctx: z.RefinementCtx): void {
  const reference = value.referenceExternalTransactionId;
  if (
    (value.kind === WagerTransactionKind.Refund || value.kind === WagerTransactionKind.Rollback) &&
    !reference
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['referenceExternalTransactionId'],
      message: `is required for ${value.kind}`,
    });
  }
  if (value.kind === WagerTransactionKind.Bet && reference) {
    ctx.addIssue({
      code: 'custom',
      path: ['referenceExternalTransactionId'],
      message: 'BET cannot reference another transaction',
    });
  }
  if (reference && reference === value.externalTransactionId) {
    ctx.addIssue({
      code: 'custom',
      path: ['referenceExternalTransactionId'],
      message: 'a transaction cannot reference itself',
    });
  }
  if (value.kind !== WagerTransactionKind.Loss && value.money.amount === '0.00') {
    ctx.addIssue({
      code: 'custom',
      path: ['money', 'amount'],
      message: `must be greater than zero for ${value.kind}`,
    });
  }
}

export const wagerTransactionRequestSchema = z.strictObject(wagerPayloadShape).superRefine(wagerRules);
export type WagerTransactionRequest = z.infer<typeof wagerTransactionRequestSchema>;

/** SQS message: the envelope may evolve (extra fields tolerated); `data` is strict. */
export const wagerTransactionRequestedMessageSchema = z.object({
  messageId: identifier(256),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime({ offset: true }),
  correlationId: identifier(128).optional(),
  data: z
    .strictObject({ ...wagerPayloadShape, idempotencyKey: idempotencyKeySchema })
    .superRefine((value, ctx) => wagerRules(value, ctx)),
});
export type WagerTransactionRequestedMessage = z.infer<typeof wagerTransactionRequestedMessageSchema>;

export const createWalletRequestSchema = z.strictObject({
  playerId: identifier(128),
  initialBalance: moneySchema,
});
export type CreateWalletRequest = z.infer<typeof createWalletRequestSchema>;

export const ledgerQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  order: z.enum(['asc', 'desc']).optional(),
});
export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;

export const uuidSchema = canonicalUuid();
