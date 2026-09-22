import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Permission, Principal } from '@ocso/auth';
import type { ActorContext } from '@ocso/application';
import type { Request } from 'express';

export const ACCESS_KEY = 'ocso:access';

export type AccessRule =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'permission'; permission: Permission }
  | { kind: 'anyPermission'; permissions: readonly Permission[] };

/** Unauthenticated route (webhooks verify their own signatures; login; health). */
export const Public = () => SetMetadata(ACCESS_KEY, { kind: 'public' } satisfies AccessRule);

/** Any signed-in user; resource checks happen in the service. */
export const Authenticated = () => SetMetadata(ACCESS_KEY, { kind: 'authenticated' } satisfies AccessRule);

/** Route requires a specific permission (deny-by-default otherwise). */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(ACCESS_KEY, { kind: 'permission', permission } satisfies AccessRule);

/** At least one of the permissions; the service applies the finer rule (e.g. which roles a CS Lead may manage). */
export const RequireAnyPermission = (...permissions: Permission[]) =>
  SetMetadata(ACCESS_KEY, { kind: 'anyPermission', permissions } satisfies AccessRule);

export interface OcsoRequest extends Request {
  principal?: Principal | undefined;
  correlationId?: string | undefined;
  sessionToken?: string | undefined;
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
