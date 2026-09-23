import * as z from 'zod';

/** Successful tool result: JSON text for 2025-era clients plus `structuredContent`. */
export function ok<T extends Record<string, unknown>>(out: T) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(out) }], structuredContent: out };
}

/** Tool-level failure (`isError`): the call ran but the business rule said no. */
export function fail(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

export const CIF = z.string().regex(/^\d{5,10}$/).describe('Customer information file number, e.g. 88214');
export const CARD_LAST4 = z.string().regex(/^\d{4}$/).describe('Last four digits of the card');
export const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Date as YYYY-MM-DD');
export const TXN_ID = z.string().regex(/^TXN-\d{4}-\d{4}$/).describe('Ledger transaction id, e.g. TXN-8841-2290');

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** Add whole months to a YYYY-MM-DD date, keeping the day of month. */
export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
