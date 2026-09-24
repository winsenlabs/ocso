import { z } from 'zod';
import type { ChannelRuntimeConfig } from '../contract/types.js';
import { channelConfigError } from '../common/errors.js';
import { TEAMS_CLOUDS, type CloudEndpoints, type TeamsCloud } from './clouds.js';

/** Microsoft Teams (Azure Bot Service) channel settings (non-secret, admin-editable). */

export const TEAMS_SECRET_KEYS = ['appPassword'] as const;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guid = (what: string) => z.string().trim().regex(GUID, `must be the ${what} (a GUID like 00000000-0000-0000-0000-000000000000)`);

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** A loopback host (`localhost`, `127.0.0.1`, `[::1]`), with an optional port. */
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

function isLoopbackUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === 'https:' || url.protocol === 'http:') && LOOPBACK_HOSTS.includes(url.hostname) && !url.username && !url.password;
}

const LOOPBACK_ONLY = 'must be a local stub on this machine (localhost, 127.0.0.1 or [::1]): these overrides exist for tests only';
const endpointUrl = z.url().refine(isLoopbackUrl, LOOPBACK_ONLY);

/**
 * Overrides for tests only (a local stub of Microsoft's endpoints); production leaves them empty and OCSO uses
 * Microsoft's published endpoints for the chosen cloud. They are loopback-only because each one moves a trust
 * boundary that a channel setting must not: the OpenID metadata decides which keys may sign inbound Bot Connector
 * tokens (an admin-chosen JWKS would let anyone forge any Teams sender), the token URL receives the app password,
 * and the service URL hosts receive the bot's bearer token.
 */
export const TeamsEndpoints = z
  .object({
    openIdMetadataUrl: endpointUrl.optional().meta({ title: 'OpenID metadata URL', description: 'Where Bot Framework signing keys are published. Tests only: loopback URLs.' }),
    tokenUrl: endpointUrl.optional().meta({ title: 'Token URL', description: 'Microsoft Entra token endpoint for the bot. Tests only: loopback URLs.' }),
    serviceUrlHosts: z
      .array(z.string().trim().toLowerCase().regex(LOOPBACK_HOST, LOOPBACK_ONLY))
      .max(20)
      .optional()
      .meta({ title: 'Extra service URL hosts', description: 'Loopback hosts added to the Bot Connector allowlist (a local stub). Tests only.' }),
  })
  .meta({ title: 'Endpoints (tests only)' });

export const TeamsSettings = z
  .object({
    appId: guid('Microsoft App ID').meta({
      title: 'Microsoft App ID',
      description: 'Azure Bot → Configuration → Microsoft App ID (the app registration’s Application (client) ID).',
    }),
    appType: z.enum(['SingleTenant', 'MultiTenant']).default('SingleTenant').meta({
      title: 'App type',
      description: 'As chosen when the Azure Bot was created. Single-tenant bots only answer people in your tenant.',
    }),
    tenantId: guid('Directory (tenant) ID')
      .optional()
      .meta({ title: 'Tenant ID', description: 'Directory (tenant) ID of the app registration. Required for single-tenant bots.' }),
    cloud: z.enum(['public', 'usgov']).default('public').meta({
      title: 'Microsoft cloud',
      description: 'public = commercial Microsoft 365. usgov = GCC, GCC High and DoD tenants.',
    }),
    requestTimeoutMs: z.number().int().min(1_000).max(60_000).default(15_000).meta({ title: 'Request timeout (ms)', description: 'How long one Microsoft call (token, signing keys, Bot Connector) may take.' }),
    /** Retries of HTTP 429 and 5xx inside one send; each waits Retry-After or a short backoff. */
    retries: z.number().int().min(0).max(5).default(2).meta({ title: 'Retries', description: 'Retries after HTTP 429 or 5xx from the Bot Connector inside one send.' }),
    /** Longest wait (seconds) a send spends in place before handing the retry to the outbox. */
    maxRetryAfterSeconds: z.number().int().min(1).max(60).default(10).meta({ title: 'Longest in-place wait (s)', description: 'A longer Retry-After goes back to the outbox backoff.' }),
    endpoints: TeamsEndpoints.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.appType === 'SingleTenant' && !value.tenantId) ctx.addIssue({ code: 'custom', path: ['tenantId'], message: 'required for a single-tenant bot' });
  });
export type TeamsSettings = z.infer<typeof TeamsSettings>;

export interface TeamsSecrets {
  appPassword: string;
}

/** What the adapter needs, with the cloud's endpoints resolved and overrides applied. */
export interface ResolvedTeamsConfig {
  channelId: string;
  settings: TeamsSettings;
  secrets: TeamsSecrets;
  endpoints: CloudEndpoints & { tokenUrl: string };
  webhookUrl?: string | undefined;
}

function settingsProblems(settings: unknown): { problems: string[]; parsed: TeamsSettings | null } {
  const result = TeamsSettings.safeParse(settings ?? {});
  if (result.success) return { problems: [], parsed: result.data };
  return { problems: result.error.issues.map((issue) => `settings.${issue.path.join('.') || '(root)'}: ${issue.message}`), parsed: null };
}

/** Secret problems; never echoes secret values. */
function secretProblems(secrets: Readonly<Record<string, string>>): string[] {
  const value = secrets['appPassword'];
  if (!value || !value.trim()) return ['secrets.appPassword: required'];
  if (/\s/.test(value)) return ['secrets.appPassword: must not contain whitespace'];
  return [];
}

export function validateTeamsConfig(settings: unknown, secrets: Readonly<Record<string, string>>): string[] {
  return [...settingsProblems(settings).problems, ...secretProblems(secrets)];
}

/** The cloud's endpoints with the channel's test overrides applied. */
export function teamsEndpoints(settings: TeamsSettings): ResolvedTeamsConfig['endpoints'] {
  const cloud = TEAMS_CLOUDS[settings.cloud as TeamsCloud];
  const authority = settings.appType === 'SingleTenant' && settings.tenantId ? settings.tenantId : cloud.multiTenantAuthority;
  const overrides = settings.endpoints ?? {};
  return {
    ...cloud,
    openIdMetadataUrl: overrides.openIdMetadataUrl ?? cloud.openIdMetadataUrl,
    tokenUrl: overrides.tokenUrl ?? `${cloud.loginHost}/${encodeURIComponent(authority)}/oauth2/v2.0/token`,
    serviceUrlHosts: [...cloud.serviceUrlHosts, ...(overrides.serviceUrlHosts ?? [])],
  };
}

const resolved = new WeakMap<ChannelRuntimeConfig, ResolvedTeamsConfig>();

/** Parse and cache a channel's config; throws a typed validation error when unusable. */
export function resolveTeamsConfig(config: ChannelRuntimeConfig): ResolvedTeamsConfig {
  const cached = resolved.get(config);
  if (cached) return cached;
  const { problems, parsed } = settingsProblems(config.settings);
  const all = [...problems, ...secretProblems(config.secrets)];
  if (!parsed || all.length) throw channelConfigError(all);
  const value: ResolvedTeamsConfig = {
    channelId: config.id,
    settings: parsed,
    secrets: { appPassword: config.secrets['appPassword'] ?? '' },
    endpoints: teamsEndpoints(parsed),
    webhookUrl: config.webhookUrl,
  };
  resolved.set(config, value);
  return value;
}

/** Settings only (verification needs no secret: the Bot Connector signs with Microsoft's keys). */
export function resolveTeamsSettings(config: ChannelRuntimeConfig): { settings: TeamsSettings; endpoints: ResolvedTeamsConfig['endpoints'] } | null {
  const parsed = TeamsSettings.safeParse(config.settings ?? {});
  return parsed.success ? { settings: parsed.data, endpoints: teamsEndpoints(parsed.data) } : null;
}

export function teamsSecretValues(config: ResolvedTeamsConfig): string[] {
  return [config.secrets.appPassword];
}
