import { asc, eq } from 'drizzle-orm';
import { discoverOIDCConfig, DiscoveryError } from '@better-auth/sso';
import { isPublicRoutableHost } from '@better-auth/core/utils/host';
import { Permission, assertCan } from '@ocso/auth';
import { conflict, forbidden, notFound, validation } from '@ocso/domain';
import { authSsoProviders, type Db } from '@ocso/db';
import { recordAudit } from '../../audit/audit.js';
import { assertPlatformWrite } from '../../settings/platform-approvals.js';
import type { ActorContext } from '../../shared/context.js';
import { SsoProviderInput, SsoProviderPatch, toSsoProviderView, type SsoProviderView } from './sso-types.js';
import type { AuthServer } from './server.js';

export { SsoProviderInput, SsoProviderPatch, type SsoProviderView } from './sso-types.js';

/**
 * SSO identity providers (OIDC, SAML 2.0) for the whole deployment, managed by
 * the Tech admin through OCSO's API (ADR-025). Better Auth stores and
 * uses them; its own provider-management endpoints are closed over HTTP, and
 * its per-owner access rule is satisfied by making the acting admin the owner.
 * Client secrets are write-only: they never leave the API.
 *
 * Maker–checker (PM/research/11 §4, sso-approval.ts): a new provider is a
 * draft (sign-in refused) until its ACTIVATE proposal is approved; deleting
 * it is a DELETE proposal; once approved, edits are UPDATE proposals.
 * Disabling is immediate.
 */
export class SsoProviderService {
  constructor(
    private readonly db: Db,
    private readonly auth: AuthServer,
    private readonly config: { publicUrl: string; trustedOrigins: readonly string[] },
  ) {}

  private assertAdmin(actor: ActorContext): void {
    if (!actor.principal) throw forbidden(Permission.DEPLOYMENT_SETTINGS_MANAGE);
    assertCan(actor.principal, Permission.DEPLOYMENT_SETTINGS_MANAGE);
  }

  async list(actor: ActorContext): Promise<SsoProviderView[]> {
    this.assertAdmin(actor);
    const rows = await this.db.select().from(authSsoProviders).orderBy(asc(authSsoProviders.name));
    return rows.map((r) => toSsoProviderView(r, this.config.publicUrl));
  }

  /** Any SSO provider usable? (the sign-in page shows "Sign in with SSO"; drafts and disabled ones are not). */
  async anyConfigured(): Promise<boolean> {
    const [row] = await this.db.select({ id: authSsoProviders.id }).from(authSsoProviders).where(eq(authSsoProviders.status, 'ACTIVE')).limit(1);
    return Boolean(row);
  }

  /** The row id of a provider (the object id of its approvals). */
  async objectId(actor: ActorContext, providerId: string): Promise<string> {
    this.assertAdmin(actor);
    return (await this.get(providerId)).id;
  }

  async create(actor: ActorContext, raw: SsoProviderInput, session: { headers: Headers }): Promise<SsoProviderView> {
    this.assertAdmin(actor);
    const input = SsoProviderInput.parse(raw);
    const [clash] = await this.db.select({ id: authSsoProviders.id }).from(authSsoProviders).where(eq(authSsoProviders.providerId, input.providerId));
    if (clash) throw conflict('sso_provider_exists', 'An SSO provider with this id already exists');
    const common = { providerId: input.providerId, domain: input.domains.join(','), name: input.name, autoProvision: input.autoProvision };
    if (input.type === 'oidc') {
      const oidc = input.oidc!;
      const endpoints = await this.discover(oidc.issuer, oidc.discoveryEndpoint);
      await this.call(() =>
        this.auth.registerSsoProvider(session.headers, {
            ...common,
            issuer: endpoints.issuer,
            oidcConfig: {
              clientId: oidc.clientId,
              clientSecret: oidc.clientSecret,
              pkce: true,
              skipDiscovery: true,
              discoveryEndpoint: endpoints.discoveryEndpoint,
              authorizationEndpoint: endpoints.authorizationEndpoint,
              tokenEndpoint: endpoints.tokenEndpoint,
              jwksEndpoint: endpoints.jwksEndpoint,
              ...(endpoints.userInfoEndpoint ? { userInfoEndpoint: endpoints.userInfoEndpoint } : {}),
              ...(endpoints.tokenEndpointAuthentication && endpoints.tokenEndpointAuthentication !== 'private_key_jwt'
                ? { tokenEndpointAuthentication: endpoints.tokenEndpointAuthentication }
                : {}),
              scopes: oidc.scopes ?? ['openid', 'email', 'profile'],
            },
        }),
      );
    } else {
      const saml = input.saml!;
      const origin = new URL(this.config.publicUrl).origin;
      await this.call(() =>
        this.auth.registerSsoProvider(session.headers, {
            ...common,
            issuer: `${origin}/api/auth/sso/saml2/sp/metadata?providerId=${encodeURIComponent(input.providerId)}`,
            samlConfig: {
              entryPoint: saml.entryPoint,
              cert: saml.certificate,
              callbackUrl: `${origin}/`,
              wantAssertionsSigned: true,
              idpMetadata: saml.metadataXml ? { metadata: saml.metadataXml } : { entityID: saml.idpEntityId ?? '', cert: saml.certificate },
              spMetadata: {},
              mapping: { email: saml.emailAttribute || 'email', name: saml.nameAttribute || 'displayName' },
            },
        }),
      );
    }
    const view = await this.get(input.providerId);
    await recordAudit(this.db, actor, {
      action: 'sso.provider_create',
      targetType: 'sso_provider',
      targetId: input.providerId,
      summary: `Added ${input.type.toUpperCase()} SSO provider ${input.name} for ${input.domains.join(', ')}${input.autoProvision ? ' (auto-provisions Service members)' : ''}`,
      after: { ...view, oidc: view.oidc ? { ...view.oidc, clientSecret: '[write-only]' } : null },
    });
    return view;
  }

  /**
   * Name, domains and provisioning policy of a draft (secrets and endpoints: delete and re-add the provider).
   * Once approved this answers 409 approval_required: the change is an UPDATE proposal (sso-approval.ts).
   */
  async update(actor: ActorContext, providerId: string, raw: SsoProviderPatch): Promise<SsoProviderView> {
    this.assertAdmin(actor);
    const patch = SsoProviderPatch.parse(raw);
    const before = await this.get(providerId);
    await this.db.transaction(async (tx) => {
      await assertPlatformWrite(tx, 'sso_provider', before.id);
      await tx
        .update(authSsoProviders)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.domains !== undefined ? { domain: patch.domains.join(',') } : {}),
          ...(patch.autoProvision !== undefined ? { autoProvision: patch.autoProvision } : {}),
          updatedAt: new Date(),
        })
        .where(eq(authSsoProviders.providerId, providerId));
      await recordAudit(tx, actor, { action: 'sso.provider_update', targetType: 'sso_provider', targetId: providerId, summary: `Updated SSO provider ${before.name}`, before, after: patch });
    });
    return this.get(providerId);
  }

  /** Stop action: immediate, never gated, allowed while a proposal is open. Re-enabling is an ACTIVATE proposal. */
  async disable(actor: ActorContext, providerId: string): Promise<SsoProviderView> {
    this.assertAdmin(actor);
    const before = await this.get(providerId);
    if (before.status === 'DISABLED') return before;
    await this.db.transaction(async (tx) => {
      await tx.update(authSsoProviders).set({ status: 'DISABLED', updatedAt: new Date() }).where(eq(authSsoProviders.id, before.id));
      await recordAudit(tx, actor, { action: 'sso.provider_disable', targetType: 'sso_provider', targetId: providerId, summary: `Disabled SSO provider ${before.name}`, before: { status: before.status }, after: { status: 'DISABLED' } });
    });
    return this.get(providerId);
  }

  private async get(providerId: string): Promise<SsoProviderView> {
    const [row] = await this.db.select().from(authSsoProviders).where(eq(authSsoProviders.providerId, providerId)).limit(1);
    if (!row) throw notFound('sso_provider', providerId);
    return toSsoProviderView(row, this.config.publicUrl);
  }

  /**
   * OIDC discovery done here (Better Auth's own discovery only trusts origins
   * listed at start-up). Only the issuer's own origin may be fetched, and only
   * when it is publicly routable or listed in OCSO_AUTH_TRUSTED_ORIGINS.
   */
  private async discover(issuer: string, discoveryEndpoint: string | undefined) {
    const issuerOrigin = new URL(issuer).origin;
    const trusted = new Set(this.config.trustedOrigins.map((o) => new URL(o).origin));
    const allowed = (url: string) => {
      const u = new URL(url);
      return trusted.has(u.origin) || (u.origin === issuerOrigin && isPublicRoutableHost(u.hostname));
    };
    try {
      return await discoverOIDCConfig({ issuer, ...(discoveryEndpoint ? { discoveryEndpoint } : {}), isTrustedOrigin: allowed });
    } catch (err) {
      if (err instanceof DiscoveryError) throw validation('sso_discovery_failed', `OIDC discovery failed: ${err.message}`);
      throw err;
    }
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status && status < 500) throw validation('sso_provider_rejected', (err as Error).message || 'The SSO provider configuration was rejected');
      throw err;
    }
  }
}
