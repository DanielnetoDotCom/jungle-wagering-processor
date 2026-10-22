import { RequestValidationError } from '../../../application/errors/application-errors';

export interface LedgerCursor {
  order: 'asc' | 'desc';
  afterVersion: number;
}

/**
 * Opaque, stable keyset cursor: base64url(JSON{w: walletId, o: order, v: lastWalletVersion}).
 * Bound to the wallet so a cursor cannot be replayed against another ledger.
 */
export function encodeLedgerCursor(walletId: string, cursor: LedgerCursor): string {
  return Buffer.from(
    JSON.stringify({ w: walletId, o: cursor.order, v: cursor.afterVersion }),
    'utf8',
  ).toString('base64url');
}

export function decodeLedgerCursor(walletId: string, encoded: string): LedgerCursor {
  try {
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      w?: unknown;
      o?: unknown;
      v?: unknown;
    };
    if (
      decoded.w === walletId &&
      (decoded.o === 'asc' || decoded.o === 'desc') &&
      typeof decoded.v === 'number' &&
      Number.isSafeInteger(decoded.v) &&
      decoded.v >= 0
    ) {
      return { order: decoded.o, afterVersion: decoded.v };
    }
  } catch {
    // fall through to the validation error below
  }
  throw new RequestValidationError('Invalid ledger cursor', [
    { path: 'cursor', message: 'is not a cursor issued for this wallet' },
  ]);
}
