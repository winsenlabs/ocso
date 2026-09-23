import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { can } from '@ocso/auth';
import { AuthPolicyService, loadPrincipal, mfaPending } from '@ocso/application';
import type { AuthServer } from '@ocso/application/auth-server';
import type { Db } from '@ocso/db';
import { DomainError, forbidden } from '@ocso/domain';
import { AUTH, DB } from '../infrastructure/tokens.js';
import { ACCESS_KEY, type AccessRule, type OcsoRequest } from './decorators.js';

const unauthenticated = () => new DomainError('authentication', 'unauthenticated', 'Sign in required');

/**
 * Global guard. Deny by default: every route must declare @Public,
 * @Authenticated or @RequirePermission. Authentication is Better Auth's
 * session (ADR-025: the BFF forwards it as `Authorization: Bearer`; /v1 never
 * accepts cookies); authorization stays OCSO's — permission checks run in code
 * on every request (build rule §14) and services add resource-level checks.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AUTH) private readonly auth: AuthServer,
    @Inject(DB) private readonly db: Db,
    @Inject(AuthPolicyService) private readonly authPolicy: AuthPolicyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.getAllAndOverride<AccessRule | undefined>(ACCESS_KEY, [context.getHandler(), context.getClass()]);
    if (!rule) throw forbidden('route', 'route has no access rule');
    if (rule.kind === 'public') return true;

    const req = context.switchToHttp().getRequest<OcsoRequest>();
    const token = bearer(req.headers.authorization);
    if (!token) throw unauthenticated();
    // Better Auth verifies the signed token and expiry; OCSO's policy plugin enforces the idle window.
    const result = await this.auth.getSession(new Headers({ authorization: `Bearer ${token}` }));
    const principal = result ? await loadPrincipal(this.db, result.user.id, 'UI', result.session.id) : null;
    if (!result || !principal) throw unauthenticated();
    const mfa = await this.authPolicy.mfaState(principal.role, result.session.authMethod, result.user.twoFactorEnabled, principal.permissions);
    req.principal = principal;
    req.authSession = { id: result.session.id, bearer: token, authMethod: result.session.authMethod, expiresAt: result.session.expiresAt, mfa };

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
}

/** The signed session token (`<token>.<hmac>`, possibly URL-encoded) from a Bearer header. */
function bearer(header: string | undefined): string | null {
  if (!header || header.slice(0, 7).toLowerCase() !== 'bearer ') return null;
  const token = header.slice(7).trim();
  return token.length >= 20 && token.length <= 400 ? token : null;
}
