import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { can } from '@ocso/auth';
import { SessionService } from '@ocso/application';
import { DomainError, forbidden } from '@ocso/domain';
import { ACCESS_KEY, type AccessRule, type OcsoRequest } from './decorators.js';

/**
 * Global guard. Deny by default: every route must declare @Public,
 * @Authenticated or @RequirePermission. Permission checks run in code on every
 * request (build rule §14); services add resource-level checks.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.getAllAndOverride<AccessRule | undefined>(ACCESS_KEY, [context.getHandler(), context.getClass()]);
    if (!rule) throw forbidden('route', 'route has no access rule');
    if (rule.kind === 'public') return true;

    const req = context.switchToHttp().getRequest<OcsoRequest>();
    const token = bearer(req.headers.authorization);
    const principal = token ? await this.sessions.authenticate(token) : null;
    if (!principal) throw new DomainError('authentication', 'unauthenticated', 'Sign in required');
    req.principal = principal;
    req.sessionToken = token ?? undefined;

    if (rule.kind === 'permission' && !can(principal, rule.permission)) {
      throw forbidden(rule.permission, `role ${principal.role} lacks ${rule.permission}`);
    }
    if (rule.kind === 'anyPermission' && !rule.permissions.some((p) => can(principal, p))) {
      throw forbidden(rule.permissions.join('|'), `role ${principal.role} lacks ${rule.permissions.join(' or ')}`);
    }
    return true;
  }
}

function bearer(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length >= 20 && token.length <= 200 ? token : null;
}
