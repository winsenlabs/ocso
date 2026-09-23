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

export const CAPABILITY_KEY = 'ocso:capability';

/**
 * How a route appears in the Ask OCSO capability catalog (PM/research/12 §3,
 * `pnpm capabilities:generate`). Only needed where the handler's doc comment
 * and the defaults are not enough: GET is READ, other writes HIGH_WRITE,
 * `stop` makes it LOW_WRITE; the approval kind is read from the handler.
 * On a controller it sets defaults for every route of that controller.
 */
export interface CapabilityOptions {
  /** Stable tool name, `<module>.<verb>_<object>` (defaults from module + handler + controller noun). */
  name?: string;
  /** One line, what a user gets done with it (defaults to the doc comment's first sentence). */
  summary?: string;
  details?: string;
  risk?: 'READ' | 'LOW_WRITE' | 'HIGH_WRITE';
  /** Pause / disable / revoke / reduce: applies at once, never an approval. */
  stop?: boolean;
  /** The route is a stop only for these body values (e.g. `{ status: 'PAUSED' }`); other values go through `approvalKind`. */
  stopWhen?: Record<string, unknown>;
  /** The approval descriptor kind when the handler cannot name it statically (it lives in the service). */
  approvalKind?: string;
  /** Nouns and synonyms for search. */
  tags?: string[];
  /** The web page for the object, e.g. `/agents/:id` (API path params by name). */
  uiHref?: string;
  /**
   * Response fields (dotted paths, e.g. `onboarding.link`) that can carry a credential or sign-in link: the
   * Ask OCSO runtime drops them before a result reaches the thread or the model (`redactResult`).
   */
  redactResponse?: string[];
  /**
   * Where the names of a map-shaped credential body field (`secrets`, `credentials`: `{ key: value }`) come from:
   * the channel kind's or the model provider kind's descriptor. Ask OCSO's card asks for them in its own fields.
   */
  credentialSource?: 'channel_kind' | 'provider_kind';
  /**
   * A response field holding server-generated secrets shown once (`{ key: value }`, e.g. `revealedSecrets`). Ask OCSO
   * hands them to the confirming user once, in the confirm response only, and never keeps them. Also redact it.
   */
  revealResponse?: string;
  /** Leave the route out of the catalog, with the reason (auth, streams, uploads, credentials…). */
  exclude?: string;
}

/** Catalog metadata for Ask OCSO; read by scripts/capabilities, never at request time. */
export const Capability = (options: CapabilityOptions) => SetMetadata(CAPABILITY_KEY, options);

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
