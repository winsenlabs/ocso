/** A Set-Cookie header, parsed into what Next's cookie store needs. */
export interface ParsedSetCookie {
  name: string;
  value: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none' | undefined;
  path: string;
  /** Seconds; 0 or negative deletes the cookie. */
  maxAge: number | undefined;
  expires: Date | undefined;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parses one Set-Cookie header (as returned by `Headers.getSetCookie()`).
 * The value is URL-decoded because Next's cookie store encodes on write.
 */
export function parseSetCookie(header: string): ParsedSetCookie | null {
  const [pair, ...attributes] = header.split(';');
  const eq = pair?.indexOf('=') ?? -1;
  if (!pair || eq <= 0) return null;
  const cookie: ParsedSetCookie = {
    name: pair.slice(0, eq).trim(),
    value: decode(pair.slice(eq + 1).trim()),
    httpOnly: false,
    secure: false,
    sameSite: undefined,
    path: '/',
    maxAge: undefined,
    expires: undefined,
  };
  for (const attribute of attributes) {
    const [rawKey, ...rest] = attribute.split('=');
    const key = rawKey?.trim().toLowerCase() ?? '';
    const value = rest.join('=').trim();
    if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'path' && value) cookie.path = value;
    else if (key === 'max-age' && /^-?\d+$/.test(value)) cookie.maxAge = Number(value);
    else if (key === 'expires' && !Number.isNaN(Date.parse(value))) cookie.expires = new Date(value);
    else if (key === 'samesite') {
      const v = value.toLowerCase();
      cookie.sameSite = v === 'lax' || v === 'strict' || v === 'none' ? v : undefined;
    }
  }
  return cookie;
}

/** True when the header deletes the cookie (Max-Age ≤ 0 or an expiry in the past). */
export function isDeletion(cookie: ParsedSetCookie, now = Date.now()): boolean {
  if (cookie.maxAge !== undefined) return cookie.maxAge <= 0;
  return cookie.expires !== undefined && cookie.expires.getTime() <= now;
}
