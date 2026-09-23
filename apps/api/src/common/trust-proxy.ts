/**
 * Express `trust proxy` from `TRUST_PROXY`:
 * - a hop count (`1`, `2`, ...): the client address is the X-Forwarded-For entry that many hops from the right,
 *   the one the nearest trusted proxy appended — clients cannot forge it (use this in production: 1 behind an ALB);
 * - `true` (default, backwards compatible): trust every hop, i.e. the leftmost entry, which a client CAN forge
 *   (per-address limits such as the public web chat's are then advisory);
 * - `false` / `0`: ignore X-Forwarded-For (the socket peer is the client).
 */
export function trustProxySetting(raw: string | undefined): boolean | number {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'true') return true;
  if (value === 'false' || value === '0') return false;
  if (/^\d{1,2}$/.test(value)) return Number(value);
  throw new Error(`TRUST_PROXY must be true, false or a proxy hop count; got "${raw}"`);
}
