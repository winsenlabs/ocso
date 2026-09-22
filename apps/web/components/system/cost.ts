import { formatMoney } from './system-meta';

/**
 * Cost figure that is honest about unpriced usage (ADR-027): "no price" when
 * requests ran but none had a price row, the priced amount plus the unpriced
 * request count when only some did, "—" when nothing ran. Never zero for
 * usage OCSO cannot price.
 */
export function formatCost(micros: number | null, currency: string | null, unpricedRequests: number): string {
  if (micros === null || !currency) return unpricedRequests > 0 ? 'no price' : '—';
  const money = formatMoney(micros, currency);
  return unpricedRequests > 0 ? `${money} + ${unpricedRequests} unpriced` : money;
}
