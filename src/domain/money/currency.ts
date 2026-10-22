import { UnsupportedCurrencyError } from '../errors/domain-errors';

/**
 * ISO-4217 currencies whose minor unit is exactly 2. Money uses a fixed scale
 * of 2, so currencies with 0 (JPY, CLP) or 3 (BHD, KWD) minor units are
 * deliberately excluded instead of being silently rounded.
 */
const TWO_MINOR_UNIT_CURRENCIES: ReadonlySet<string> = new Set([
  'AUD',
  'BRL',
  'CAD',
  'CHF',
  'CNY',
  'DKK',
  'EUR',
  'GBP',
  'INR',
  'MXN',
  'NOK',
  'NZD',
  'PEN',
  'PLN',
  'SEK',
  'USD',
  'ZAR',
]);

const ISO_CODE_PATTERN = /^[A-Z]{3}$/;

export function isSupportedCurrency(code: string): boolean {
  return ISO_CODE_PATTERN.test(code) && TWO_MINOR_UNIT_CURRENCIES.has(code);
}

export function assertCurrency(code: unknown): string {
  if (typeof code !== 'string' || !isSupportedCurrency(code)) {
    throw new UnsupportedCurrencyError(String(code));
  }
  return code;
}
