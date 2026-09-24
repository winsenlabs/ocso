import { Global, Injectable, Module } from '@nestjs/common';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DomainError } from '@ocso/domain';

/**
 * Ask OCSO delegation tokens (PM/research/12 §6). When Ask OCSO runs an API route for a user it sends the
 * request over a private loopback listener with one of these instead of the user's session token:
 *
 * - signed with a key that exists only in this process's memory (never configured, never persisted), so no
 *   other process or host can mint one;
 * - valid for 60 seconds and single use;
 * - bound to the user, their session (refused once the session ends or goes idle), the Ask OCSO thread, the
 *   card or the read's tool call, and the exact method and path of the one request;
 * - or, when Ask OCSO answers through a linked chat account (Slack, Teams), bound to the user and that link
 *   instead of a session (`linkId`, `surface`): refused once the link is revoked, or the user is disabled or no
 *   longer holds internal_agent.use;
 * - accepted only on a connection from loopback to the private listener's own port: never from the public
 *   listener, a reverse proxy or another host.
 *
 * The auth guard then loads the principal exactly as for a session (fresh permissions and teams), marks it
 * via = INTERNAL_AGENT with the thread and card, so audit rows name the human, the surface and the card.
 */
export interface DelegationClaims {
  jti: string;
  userId: string;
  /** The signed-in session Ask OCSO acts within (the drawer). Exactly one of sessionId and linkId is set. */
  sessionId?: string | undefined;
  /** The linked chat account Ask OCSO acts through (a staff chat channel), with its surface (`slack`). */
  linkId?: string | undefined;
  surface?: string | undefined;
  threadId: string;
  cardId?: string | undefined;
  callId?: string | undefined;
  method: string;
  path: string;
  /** Expiry, epoch ms. */
  exp: number;
}

export type DelegationGrant = Omit<DelegationClaims, 'jti' | 'exp'>;

export const DELEGATION_SCHEME = 'delegation';
const PREFIX = 'dlg';
export const DELEGATION_TTL_MS = 60_000;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const refused = (why: string) => new DomainError('authentication', 'delegation_refused', `Delegated request refused: ${why}`);

const b64 = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

@Injectable()
export class DelegationTokens {
  private readonly key = randomBytes(32);
  /** jti → expiry: a token is accepted once. Pruned as tokens expire. */
  private readonly used = new Map<string, number>();
  private listenerPort: number | null = null;

  /** The private loopback listener's port; tokens are accepted only on it. */
  setListenerPort(port: number | null): void {
    this.listenerPort = port;
  }

  issue(grant: DelegationGrant, now = Date.now()): string {
    if (Boolean(grant.sessionId) === Boolean(grant.linkId)) throw refused('bind the token to a session or to a chat link');
    const claims: DelegationClaims = { ...grant, jti: randomUUID(), exp: now + DELEGATION_TTL_MS };
    const payload = b64(JSON.stringify(claims));
    return `${PREFIX}.${payload}.${this.sign(payload)}`;
  }

  /**
   * Verify and use a token for one request. Throws `authentication` for anything but a fresh, unused, correctly
   * signed token presented on the private loopback listener for the method and path it was issued for.
   */
  consume(token: string, socket: { remoteAddress?: string | undefined; localPort?: number | undefined }, request: { method: string; path: string }, now = Date.now()): DelegationClaims {
    if (!LOOPBACK.has(socket.remoteAddress ?? '')) throw refused('not from loopback');
    if (this.listenerPort === null || socket.localPort !== this.listenerPort) throw refused('not on the internal listener');
    const [prefix, payload, signature, extra] = token.split('.');
    if (prefix !== PREFIX || !payload || !signature || extra !== undefined) throw refused('malformed token');
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw refused('bad signature');
    let claims: DelegationClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as DelegationClaims;
    } catch {
      throw refused('malformed token');
    }
    if (typeof claims.exp !== 'number' || claims.exp <= now) throw refused('expired');
    if (Boolean(claims.sessionId) === Boolean(claims.linkId)) throw refused('malformed token');
    if (claims.method !== request.method.toUpperCase() || claims.path !== request.path) throw refused('issued for another request');
    this.prune(now);
    if (this.used.has(claims.jti)) throw refused('already used');
    this.used.set(claims.jti, claims.exp);
    return claims;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.key).update(`${PREFIX}.${payload}`).digest('base64url');
  }

  private prune(now: number): void {
    for (const [jti, exp] of this.used) if (exp <= now) this.used.delete(jti);
  }
}

/** Global: the auth guard verifies what the internal agent's runner issues. */
@Global()
@Module({ providers: [DelegationTokens], exports: [DelegationTokens] })
export class DelegationModule {}
