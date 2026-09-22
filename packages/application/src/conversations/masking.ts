/**
 * Display masking for channel identities ("+91 98•••41208", "web · sess 8f2a").
 * Full identifiers stay in the database and in customer detail views for
 * permitted roles; lists show masked forms.
 */
export function maskIdentity(identity: string | null): string | null {
  if (!identity) return null;
  const sep = identity.indexOf(':');
  const kind = sep > 0 ? identity.slice(0, sep) : '';
  const value = sep > 0 ? identity.slice(sep + 1) : identity;
  if (kind.includes('phone') || /^\+?\d{8,15}$/.test(value)) return maskPhone(value);
  if (kind.startsWith('webchat')) return `web · sess ${value.slice(-4)}`;
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
