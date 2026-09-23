import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Permission, Principal } from '@ocso/auth';
import type { ActorContext, MfaState } from '@ocso/application';
import type { Request } from 'express';

export const ACCESS_KEY = 'ocso:access';

export type AccessRule =
  | { kind: 'public' }
  | { kind: 'authenticated'; allowPendingMfa?: boolean }
  | { kind: 'permission'; permission: Permission }
  | { kind: 'anyPermission'; permissions: readonly Permission[] };

/** Unauthenticated route (webhooks verify their own signatures; login; health). */
export const Public = () => SetMetadata(ACCESS_KEY, { kind: 'public' } satisfies AccessRule);

/**
 * Any signed-in user; resource checks happen in the service. `allowPendingMfa`
 * admits sessions whose role requires MFA before a second factor is enrolled
 * (only what the enrollment flow needs: who am I, sign out).
 */
export const Authenticated = (options: { allowPendingMfa?: boolean } = {}) =>
  SetMetadata(ACCESS_KEY, { kind: 'authenticated', ...(options.allowPendingMfa ? { allowPendingMfa: true } : {}) } satisfies AccessRule);

/** Route requires a specific permission (deny-by-default otherwise). */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(ACCESS_KEY, { kind: 'permission', permission } satisfies AccessRule);

/** At least one of the permissions; the service applies the finer rule (e.g. which roles a Lead may manage). */
export const RequireAnyPermission = (...permissions: Permission[]) =>
  SetMetadata(ACCESS_KEY, { kind: 'anyPermission', permissions } satisfies AccessRule);

export interface OcsoRequest extends Request {
  principal?: Principal | undefined;
  correlationId?: string | undefined;
  /** The Better Auth session behind `principal` (set by AuthGuard). */
  authSession?: AuthenticatedSession | undefined;
}

export interface AuthenticatedSession {
  id: string;
  /** Signed session token as sent by the BFF (Bearer); lets the API act as this session towards Better Auth. */
  bearer: string;
  authMethod: string;
  expiresAt: Date;
  mfa: MfaState;
}

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  const req = ctx.switchToHttp().getRequest<OcsoRequest>();
  if (!req.principal) throw new Error('CurrentPrincipal used on a route without authentication');
  return req.principal;
});

/** The ActorContext for application services: principal + correlation + ip. */
export const Actor = createParamDecorator((_: unknown, ctx: ExecutionContext): ActorContext => {
  const req = ctx.switchToHttp().getRequest<OcsoRequest>();
  return { principal: req.principal ?? null, correlationId: req.correlationId ?? 'unknown', ip: req.ip };
});
