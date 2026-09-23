/**
 * Prices are stored as integer micro-units per 1M tokens (model_pricing).
 * The UI shows and accepts plain decimal amounts per 1M tokens.
 */

const DECIMAL = /^\d{1,7}(\.\d{1,6})?$/;

/** "3", "0.075", "15.00" → micros; null for blank; NaN for invalid input. */
export function microsFromDecimal(raw: string): number | null {
  const value = raw.trim();
  if (value === '') return null;
  if (!DECIMAL.test(value)) return Number.NaN;
  const [whole = '0', fraction = ''] = value.split('.');
  return Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
}

/** 3_000_000 → "3.00"; 75_000 → "0.075"; null → "". */
export function decimalFromMicros(micros: number | null): string {
  if (micros === null) return '';
  const whole = Math.floor(micros / 1_000_000);
  const fraction = String(micros % 1_000_000).padStart(6, '0').replace(/0+$/, '');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

/** Table cell: "3.00" with the currency code, or an em dash when not priced. */
export function formatPerMTok(micros: number | null, currency: string): string {
  return micros === null ? '—' : `${decimalFromMicros(micros)} ${currency}`;
}
