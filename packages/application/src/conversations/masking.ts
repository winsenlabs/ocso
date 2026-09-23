/**
 * Display masking for channel identities ("+91 98•••41208", "priya@…").
 * Full identifiers stay in the database and in customer detail views for
 * permitted roles; lists show masked forms.
 *
 * Channel plugins display their own identity kinds (`ChannelAdapter.
 * displayIdentity`, e.g. web chat's "web · sess 8f2a"): the API installs the
 * channel registry's hook once at start-up. Anything no plugin claims gets
 * the generic rules below, which know identity shapes, never channel kinds.
 */

/** A plugin's display of `kind:value`, or null when no plugin claims the kind. */
export type IdentityDisplay = (identityKind: string, value: string) => string | null;

let pluginDisplay: IdentityDisplay | null = null;

/** Install (or with null, remove) the channel plugins' identity display hook. */
export function setIdentityDisplay(display: IdentityDisplay | null): void {
  pluginDisplay = display;
}

export function maskIdentity(identity: string | null): string | null {
  if (!identity) return null;
  const sep = identity.indexOf(':');
  const kind = sep > 0 ? identity.slice(0, sep) : '';
  const value = sep > 0 ? identity.slice(sep + 1) : identity;
  const shown = kind ? pluginDisplay?.(kind, value) : null;
  if (shown) return shown;
  if (kind.includes('phone') || /^\+?\d{8,15}$/.test(value)) return maskPhone(value);
  if (kind.includes('email') && value.includes('@')) return `${value.slice(0, Math.min(5, value.indexOf('@')))}@…`;
  return value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length < 8) return phone;
  const cc = digits.length > 10 ? digits.slice(0, digits.length - 10) : '';
  const rest = digits.slice(cc.length);
  return `${cc ? `+${cc} ` : ''}${rest.slice(0, 2)}•••${rest.slice(-5)}`;
}
