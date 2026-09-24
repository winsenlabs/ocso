/**
 * Microsoft cloud endpoints for Azure Bot Service (Bot Framework) bots. The
 * public cloud is the default; US Government (GCC, GCC High, DoD) only when
 * the channel is configured for it. Values follow the Bot Framework SDK's
 * AuthenticationConstants / GovernmentConstants.
 */

export type TeamsCloud = 'public' | 'usgov';

export interface CloudEndpoints {
  /** Bot Framework OpenID metadata: its `jwks_uri` lists the keys that sign channel → bot tokens. */
  openIdMetadataUrl: string;
  /** `iss` of tokens the Bot Connector sends to the bot. */
  issuer: string;
  /** Microsoft Entra login host for the bot → channel client-credentials token. */
  loginHost: string;
  /** Authority used for multi-tenant bots (single-tenant bots use their tenant id). */
  multiTenantAuthority: string;
  /** Scope of the bot → connector token. */
  scope: string;
  /**
   * Hosts the Bot Connector may name as an activity's `serviceUrl` (exact names, or `*.suffix` for
   * any subdomain). OCSO only ever sends a bearer token to these hosts (SSRF guard), so a wildcard
   * is only allowed under a domain only Microsoft can add names to: never `*.trafficmanager.net`,
   * where any Azure customer can create a Traffic Manager profile pointing anywhere.
   */
  serviceUrlHosts: readonly string[];
}

export const TEAMS_CLOUDS: Readonly<Record<TeamsCloud, CloudEndpoints>> = {
  public: {
    openIdMetadataUrl: 'https://login.botframework.com/v1/.well-known/openidconfiguration',
    issuer: 'https://api.botframework.com',
    loginHost: 'https://login.microsoftonline.com',
    multiTenantAuthority: 'botframework.com',
    scope: 'https://api.botframework.com/.default',
    serviceUrlHosts: ['smba.trafficmanager.net', '*.botframework.com'],
  },
  usgov: {
    openIdMetadataUrl: 'https://login.botframework.azure.us/v1/.well-known/openidconfiguration',
    issuer: 'https://api.botframework.us',
    loginHost: 'https://login.microsoftonline.us',
    multiTenantAuthority: 'MicrosoftServices.onmicrosoft.com',
    scope: 'https://api.botframework.us/.default',
    serviceUrlHosts: ['*.botframework.azure.us', 'smba.infra.gcc.teams.microsoft.com', 'smba.infra.gov.teams.microsoft.us', 'smba.infra.dod.teams.microsoft.us'],
  },
};
