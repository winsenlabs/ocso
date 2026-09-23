import { Inject, Injectable, Optional, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { can, type Principal } from '@ocso/auth';
import { AuthPolicyService, SessionLiveness, findLiveSession, loadPrincipal, mfaPending } from '@ocso/application';
import type { AuthServer } from '@ocso/application/auth-server';
import type { Db } from '@ocso/db';
import { DomainError, forbidden } from '@ocso/domain';
import { AUTH, DB } from '../infrastructure/tokens.js';
import { ACCESS_KEY, type AccessRule, type OcsoRequest } from './decorators.js';
import { DELEGATION_SCHEME, DelegationTokens } from './delegation.js';

const unauthenticated = () => new DomainError('authentication', 'unauthenticated', 'Sign in required');

/**
 * Global guard. Deny by default: every route must declare @Public,
 * @Authenticated or @RequirePermission. Authentication is Better Auth's
 * session (ADR-025: the BFF forwards it as `Authorization: Bearer`; /v1 never
 * accepts cookies); authorization stays OCSO's — permission checks run in code
 * on every request (build rule §14) and services add resource-level checks.
 *
 * Ask OCSO runs routes as the user with a delegation token instead (`Authorization: Delegation …`,
 * PM/research/12 §6): accepted only on the private loopback listener, single use, bound to the request and to a
 * session that is still live; the principal is built the same way and marked via = INTERNAL_AGENT.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AUTH) private readonly auth: AuthServer,
    @Inject(DB) private readonly db: Db,
    @Inject(AuthPolicyService) private readonly authPolicy: AuthPolicyService,
    @Inject(SessionLiveness) private readonly liveness: SessionLiveness,
    /** Absent in apps without the delegation module (narrow test apps): delegated requests are then refused. */
    @Optional() @Inject(DelegationTokens) private readonly delegation: DelegationTokens | null = null,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.getAllAndOverride<AccessRule | undefined>(ACCESS_KEY, [context.getHandler(), context.getClass()]);
    if (!rule) throw forbidden('route', 'route has no access rule');
    if (rule.kind === 'public') return true;

    const req = context.switchToHttp().getRequest<OcsoRequest>();
    const delegated = delegationToken(req.headers.authorization);
    const principal = delegated !== null ? await this.delegatedPrincipal(req, delegated) : await this.sessionPrincipal(req);
    const mfa = req.authSession!.mfa;

    if (mfaPending(mfa) && !(rule.kind === 'authenticated' && rule.allowPendingMfa)) {
      throw new DomainError('authorization', 'mfa_enrollment_required', 'Set up two-factor authentication to continue');
    }
    if (rule.kind === 'permission' && !can(principal, rule.permission)) {
      throw forbidden(rule.permission, `role ${principal.role} lacks ${rule.permission}`);
    }
    if (rule.kind === 'anyPermission' && !rule.permissions.some((p) => can(principal, p))) {
      throw forbidden(rule.permissions.join('|'), `role ${principal.role} lacks ${rule.permissions.join(' or ')}`);
    }
    return true;
  }

  private async sessionPrincipal(req: OcsoRequest): Promise<Principal> {
    const token = bearer(req.headers.authorization);
    if (!token) throw unauthenticated();
    // Better Auth verifies the signed token and expiry; OCSO's policy plugin enforces the idle window.
    const result = await this.auth.getSession(new Headers({ authorization: `Bearer ${token}` }));
    const principal = result ? await loadPrincipal(this.db, result.user.id, 'UI', result.session.id) : null;
    if (!result || !principal) throw unauthenticated();
    const mfa = await this.authPolicy.mfaState(principal.role, result.session.authMethod, result.user.twoFactorEnabled, principal.permissions);
    req.principal = principal;
    req.authSession = { id: result.session.id, bearer: token, authMethod: result.session.authMethod, expiresAt: result.session.expiresAt, mfa };
    return principal;
  }

  /** Ask OCSO acting for a user (PM/research/12 §6): the same principal, never more than the live session allows. */
  private async delegatedPrincipal(req: OcsoRequest, token: string): Promise<Principal> {
    // Ask OCSO never drives its own routes or sign-in.
    if (!this.delegation || req.path.startsWith('/v1/internal-agent') || req.path.startsWith('/api/auth')) throw unauthenticated();
    const claims = this.delegation.consume(token, req.socket, { method: req.method, path: req.path });
    // The session must still be live (not revoked, expired, idle or waiting for MFA enrolment).
    if (!(await this.liveness.isLive(claims.sessionId))) throw unauthenticated();
    const session = await findLiveSession(this.db, { sessionId: claims.sessionId });
    if (!session || session.userId !== claims.userId) throw unauthenticated();
    const loaded = await loadPrincipal(this.db, claims.userId, 'INTERNAL_AGENT', claims.sessionId);
    if (!loaded) throw unauthenticated();
    const principal: Principal = { ...loaded, delegation: { threadId: claims.threadId, ...(claims.cardId ? { cardId: claims.cardId } : {}), ...(claims.callId ? { callId: claims.callId } : {}) } };
    // Bootstrap self-approval is UI-only (owner decision): refused here too, whatever the body says.
    const approval = (req.body as { approval?: { bootstrap?: unknown } } | undefined)?.approval;
    if (approval && typeof approval === 'object' && approval.bootstrap !== undefined) throw forbidden('approval.bootstrap', 'Ask OCSO never self-approves; bootstrap is done in the OCSO UI');
    const mfa = await this.authPolicy.mfaState(principal.role, session.authMethod, session.twoFactorEnabled, principal.permissions);
    req.principal = principal;
    req.authSession = { id: claims.sessionId, bearer: '', authMethod: session.authMethod, expiresAt: session.expiresAt, mfa };
    return principal;
  }
}

/** The delegation token from `Authorization: Delegation <token>`, or null for any other scheme. */
function delegationToken(header: string | undefined): string | null {
  if (!header) return null;
  const space = header.indexOf(' ');
  if (space < 0 || header.slice(0, space).toLowerCase() !== DELEGATION_SCHEME) return null;
  const token = header.slice(space + 1).trim();
  return token.length > 0 && token.length <= 2000 ? token : null;
}

/** The signed session token (`<token>.<hmac>`, possibly URL-encoded) from a Bearer header. */
function bearer(header: string | undefined): string | null {
  if (!header || header.slice(0, 7).toLowerCase() !== 'bearer ') return null;
  const token = header.slice(7).trim();
  return token.length >= 20 && token.length <= 400 ? token : null;
}
