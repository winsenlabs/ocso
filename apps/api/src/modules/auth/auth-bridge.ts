import { isIP } from 'node:net';
import type { AuthServer } from '@ocso/application/auth-server';
import { DomainError } from '@ocso/domain';
import type { OcsoRequest } from '../../common/decorators.js';

/**
 * Calls a Better Auth endpoint in-process through its HTTP handler, so the
 * request gets exactly what a browser request gets: rate limiting, CSRF/origin
 * checks, OCSO's policy plugin and audit. Used by the /v1 compatibility login.
 */
export async function callAuthEndpoint(auth: AuthServer, publicUrl: string, path: string, req: OcsoRequest, body: unknown): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json' });
  // Set by the web tier from its trusted proxy hop; /v1 is never reachable from outside (ADR-020).
  const clientIp = req.header('x-ocso-client-ip');
  if (clientIp && isIP(clientIp)) headers.set('x-ocso-client-ip', clientIp);
  const userAgent = req.header('user-agent');
  if (userAgent) headers.set('user-agent', userAgent.slice(0, 300));
  if (req.correlationId) headers.set('x-correlation-id', req.correlationId);
  return auth.handler(new Request(new URL(`/api/auth${path}`, publicUrl), { method: 'POST', headers, body: JSON.stringify(body) }));
}

/** Maps a Better Auth error response to OCSO's error envelope (docs/archive/specs/14 §5). */
export async function authErrorFrom(res: Response): Promise<DomainError> {
  let code = '';
  let message = '';
  try {
    const body = (await res.json()) as { code?: unknown; message?: unknown };
    code = typeof body.code === 'string' ? body.code : '';
    message = typeof body.message === 'string' ? body.message : '';
  } catch {
    // non-JSON error body
  }
  if (res.status === 429) return new DomainError('authentication', 'too_many_attempts', message || 'Too many attempts. Try again later.');
  if (res.status === 400 && code) return new DomainError('validation', code.toLowerCase(), message || 'Invalid request');
  if (res.status === 401 || res.status === 403) return new DomainError('authentication', 'invalid_credentials', 'Invalid email or password');
  return new DomainError('internal', 'auth_unavailable', 'Sign-in failed');
}
