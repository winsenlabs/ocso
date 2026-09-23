import { readFileSync } from 'node:fs';
import { createApprovalRegistry } from '@ocso/application';
import { Permission } from '@ocso/auth';
import { describe, expect, it } from 'vitest';
import { CATALOG_PATH, extractCatalog, serializeCatalog } from '../../../scripts/capabilities/extract.mjs';
import { APP_ROUTES, CAPABILITIES, CAPABILITY_CATALOG, capabilityAllowed, capabilityByName, fillPath, isAppRoute, isStopCall, redactResult, type Capability } from '../src/catalog/index.js';
import { DEFAULT_TOOLS } from '../src/registry.js';

/**
 * The Ask OCSO capability catalog guard (PM/research/12 §3): the committed
 * catalog is what the API says today, every route is either in it with a
 * summary and a risk or deliberately excluded with a reason, and nothing in it
 * reaches a credential, a bootstrap approval or an auth/stream/upload route.
 */

const STALE = 'packages/internal-agent/src/catalog/capabilities.generated.json is stale: run `pnpm capabilities:generate` and commit the result';

/**
 * GET routes next to credentials (channels, model providers, MCP, webhooks, notification destinations,
 * secrets, SSO/email/auth settings). Each was reviewed to answer without secret values (credential names
 * or "configured" flags only). A new read here is a deliberate addition to this list.
 */
const REVIEWED_CREDENTIAL_ADJACENT_READS = [
  'alerts.get_notification_destination',
  'alerts.list_notification_destination_kinds',
  'alerts.list_notification_destinations',
  'channels.get_channel',
  'channels.list_channel_kinds',
  'channels.list_channels',
  'mcp.get_connection',
  'mcp.get_connection_health_history',
  'mcp.get_personal_connection',
  'mcp.list_connection_tools',
  'mcp.list_connections',
  'mcp.list_my_connections',
  'mcp.list_personal_connection_tools',
  'mcp.list_personal_templates',
  'models.get_provider',
  'models.list_provider_kinds',
  'models.list_provider_models',
  'models.list_providers',
  'security.list_secrets',
  'security.list_signing_keys',
  'settings.get_auth_policy',
  'settings.get_email_status',
  'settings.list_sso_providers',
  'webhooks.list_deliveries',
  'webhooks.list_event_types',
  'webhooks.list_webhooks',
];
/**
 * Writes next to credentials, each reviewed to answer without a secret value (refs, kids, "configured" flags,
 * test outcomes). Writes that do return one (a generated key, a signing secret, a sign-in link) are excluded
 * (SECRET_RETURNING_WRITES) or redact the field (REDACTED_RESPONSES). A new write here is a deliberate addition.
 */
const REVIEWED_CREDENTIAL_ADJACENT_WRITES = [
  'alerts.create_notification_destination',
  'alerts.delete_notification_destination',
  'alerts.test_notification_destination',
  'alerts.update_notification_destination',
  'channels.create_channel',
  'channels.delete_channel',
  'channels.test_channel',
  'channels.update_channel',
  'mcp.approve_connection',
  'mcp.check_connection_health',
  'mcp.check_personal_connection_health',
  'mcp.classify_connection_tools',
  'mcp.create_connection',
  'mcp.create_personal_connection',
  'mcp.delete_connection',
  'mcp.delete_personal_connection',
  'mcp.disable_connection',
  'mcp.discover_connection_tools',
  'mcp.discover_personal_connection_tools',
  'mcp.enable_connection',
  'mcp.rediscover_connection_tools',
  'mcp.set_connection_header_auth',
  'models.create_provider',
  'models.delete_provider',
  'models.test_provider',
  'models.update_provider',
  'security.rotate_signing_key',
  'settings.delete_sso_provider',
  'settings.send_test_email',
  'settings.set_sso_provider_status',
  'settings.update_auth_policy',
  'settings.update_sso_provider',
  'webhooks.delete_webhook',
  'webhooks.test_webhook',
  'webhooks.update_webhook',
];
/**
 * Routes whose response can carry a secret or a sign-in link: never in the catalog. (POST /v1/channels is in it:
 * its generated web chat key is redacted and handed to the user once through the confirm response's `reveal`.)
 */
const SECRET_RETURNING_WRITES = [
  'POST /v1/webhooks', // the signing secret, once
  'POST /v1/webhooks/:id/rotate-secret',
  'POST /v1/users/:id/invite', // log email driver: the invite link
  'POST /v1/users/:id/password-reset',
];
/** Capabilities whose responses are redacted by the runtime (`redactResult`) before the thread and model see them. */
const REDACTED_RESPONSES: Record<string, string[]> = {
  'channels.create_channel': ['revealedSecrets'], // web chat: the generated backend key, shown once through `reveal` only
  'users.create_user': ['onboarding.link'], // approval skipped: the invite link (log email driver)
  'users.update_user': ['onboarding.link'], // a pending user activated at once: the same
};
/** Non-GET routes that run straight from execute_tool (no card): reviewed to change nothing and spend nothing. */
const REVIEWED_NON_GET_READS = ['channels.test_channel', 'models.validate_profile'];
const CREDENTIAL_ADJACENT = /^\/v1\/(channels(?!\/:\w+\/templates)|model-providers|mcp\/|webhooks|notification-destinations|secrets|security|settings\/(sso-providers|email|auth-policy))/;
const SECRET_FIELD = /(^|_|[a-z])(secrets?|password|passphrase|api_?key|token|credentials?|private_?key)$/i;

/** Every `[name, schema]` property anywhere in a JSON Schema. */
function properties(schema: unknown, out: Array<[string, Record<string, unknown>]> = []): Array<[string, Record<string, unknown>]> {
  if (Array.isArray(schema)) schema.forEach((s) => properties(s, out));
  else if (schema && typeof schema === 'object') {
    for (const [k, v] of Object.entries(schema)) {
      if (k === 'properties' && v && typeof v === 'object') {
        for (const [name, sub] of Object.entries(v as Record<string, Record<string, unknown>>)) {
          out.push([name, sub]);
          properties(sub, out);
        }
      } else properties(v, out);
    }
  }
  return out;
}

const http = CAPABILITIES.filter((c) => c.method !== 'INSIGHT' && c.method !== 'UI');

describe('capability catalog', () => {
  it('is current with the API (regenerate with `pnpm capabilities:generate`)', { timeout: 120_000 }, async () => {
    const fresh = await extractCatalog();
    expect(serializeCatalog(fresh) === readFileSync(CATALOG_PATH, 'utf8'), STALE).toBe(true);
  });

  it('names are unique, stable-shaped tool names', () => {
    const names = CAPABILITIES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    expect(capabilityByName('agents.update_agent')?.path).toBe('/v1/agents/:id');
    expect(capabilityByName('approvals.list_approvals')?.method).toBe('GET');
  });

  it('every capability has a one-line summary, a risk and known permissions', () => {
    const permissions = new Set<string>(Object.values(Permission));
    for (const c of CAPABILITIES) {
      expect(c.summary, c.name).toMatch(/\S/);
      expect(c.summary.length, `${c.name} summary is long`).toBeLessThanOrEqual(200);
      expect(c.summary, c.name).not.toContain('\n');
      expect(['READ', 'LOW_WRITE', 'HIGH_WRITE'], c.name).toContain(c.risk);
      for (const p of c.permissions.list) expect(permissions.has(p), `${c.name}: ${p}`).toBe(true);
      if (c.method === 'GET') expect(c.risk, c.name).toBe('READ');
      if (c.stop) expect(c.risk, c.name).toBe('LOW_WRITE');
    }
  });

  it('approvable routes name a registered approval kind and are HIGH_WRITE', () => {
    const kinds = new Set(createApprovalRegistry().kinds());
    const governed = CAPABILITIES.filter((c) => c.approvalKind);
    expect(governed.length).toBeGreaterThan(40);
    for (const c of governed) {
      expect(kinds.has(c.approvalKind!), `${c.name}: ${c.approvalKind}`).toBe(true);
      expect(c.risk, c.name).toBe('HIGH_WRITE');
      expect(c.method, c.name).not.toBe('GET');
    }
    expect(capabilityByName('agents.update_agent')?.approvalKind).toBe('agent');
    expect(capabilityByName('settings.update_worker_settings')?.approvalKind).toBe('deployment_settings');
    expect(capabilityByName('users.change_user_permissions')?.approvalKind).toBe('permission_change');
  });

  it('inputs never carry `approval`, bootstrap or credential fields', () => {
    for (const c of CAPABILITIES) {
      for (const [name, schema] of properties(c.input)) {
        expect(name, `${c.name} exposes approval`).not.toBe('approval');
        expect(name, `${c.name} exposes bootstrap`).not.toBe('bootstrap');
        const scalar = ['boolean', 'number', 'integer'].includes(String(schema['type']));
        if (!scalar) expect(SECRET_FIELD.test(name), `${c.name} exposes credential field ${name}`).toBe(false);
      }
      if (c.secretInputs) expect(c.input.body?.['additionalProperties'], c.name).toBe(false);
      // Every credential field the route takes is one the card asks for, and the other way round.
      expect((c.credentials ?? []).map((x) => x.field).sort(), c.name).toEqual([...(c.secretInputs ?? [])].sort());
      if (c.revealResponse) expect(c.redactResponse, c.name).toContain(c.revealResponse);
    }
  });

  it('MCP OAuth stays out (a browser redirect) and says where to do it', () => {
    const oauth = CAPABILITY_CATALOG.excluded.find((e) => e.route === 'POST /v1/mcp/connections/:id/oauth/begin');
    expect(oauth?.reason).toMatch(/\/connections/);
    expect(capabilityByName('mcp.set_connection_header_auth')?.approvalKind).toBe('mcp_connection');
    expect(capabilityByName('channels.create_channel')?.approvalKind).toBe('channel');
  });

  it('leaves out auth, public ingress, streams, uploads, downloads and its own routes', () => {
    const forbidden = [/^\/v1\/(auth|setup)(\/|$)/, /^\/public\//, /^\/channels\//, /^\/oauth\//, /^\/blobs\//, /^\/health\/(live|ready)$/, /^\/\.well-known\//, /^\/v1\/internal-agent(\/|$)/, /^\/v1\/test-hooks/, /^\/v1\/realtime\/stream$/, /\/attachments$/, /\/export$/];
    for (const c of http) for (const re of forbidden) expect(re.test(c.path), `${c.name} ${c.path} should be excluded`).toBe(false);
    const excluded = CAPABILITY_CATALOG.excluded.map((e) => e.route);
    for (const route of ['POST /v1/auth/login', 'GET /v1/realtime/stream', 'POST /v1/conversations/:id/attachments', 'POST /v1/internal-agent/chat', 'POST /v1/approvals', 'POST /v1/webhooks', 'POST /v1/webhooks/:id/rotate-secret']) {
      expect(excluded, route).toContain(route);
    }
    for (const e of CAPABILITY_CATALOG.excluded) expect(e.reason, e.route).toMatch(/\S/);
  });

  it('credential-adjacent reads are the reviewed list', () => {
    const found = http.filter((c) => c.method === 'GET' && CREDENTIAL_ADJACENT.test(c.path)).map((c) => c.name).sort();
    expect(found).toEqual([...REVIEWED_CREDENTIAL_ADJACENT_READS].sort());
  });

  it('credential-adjacent writes are the reviewed list; secret-returning writes are excluded or redacted', () => {
    const found = http.filter((c) => c.method !== 'GET' && CREDENTIAL_ADJACENT.test(c.path)).map((c) => c.name).sort();
    expect(found).toEqual([...REVIEWED_CREDENTIAL_ADJACENT_WRITES].sort());
    const excluded = CAPABILITY_CATALOG.excluded.map((e) => e.route);
    for (const route of SECRET_RETURNING_WRITES) expect(excluded, route).toContain(route);
    const redacted = Object.fromEntries(CAPABILITIES.filter((c) => c.redactResponse).map((c) => [c.name, c.redactResponse]));
    expect(redacted).toEqual(REDACTED_RESPONSES);
  });

  it('non-GET reads (no card) are the reviewed list; the router simulation is a card', () => {
    const found = http.filter((c) => c.method !== 'GET' && c.risk === 'READ').map((c) => c.name).sort();
    expect(found).toEqual([...REVIEWED_NON_GET_READS].sort());
    expect(capabilityByName('routers.simulate_router')?.risk).toBe('LOW_WRITE');
  });

  it('carries the read-only insight tools and ui.open_page, not the insight write tools', () => {
    for (const tool of DEFAULT_TOOLS) {
      const entry = capabilityByName(`insight.${tool.name}`);
      if (tool.risk === 'READ') {
        expect(entry?.method, tool.name).toBe('INSIGHT');
        expect(entry?.permissions.list, tool.name).toEqual([tool.permission]);
      } else expect(entry, `${tool.name} is a write: it goes through its API route`).toBeUndefined();
    }
    expect(capabilityByName('ui.open_page')?.risk).toBe('READ');
  });

  it('object links point at app pages', () => {
    expect(APP_ROUTES).toContain('/agents/:id');
    expect(APP_ROUTES).toContain('/approvals');
    expect(APP_ROUTES.some((r) => r.startsWith('/login'))).toBe(false);
    for (const c of CAPABILITIES) if (c.uiHref) expect(APP_ROUTES, c.name).toContain(c.uiHref.replace(/:\w+/g, ':id'));
  });
});

describe('catalog helpers', () => {
  const status = capabilityByName('agents.set_agent_status') as Capability;

  it('stops: stop routes and stop values', () => {
    expect(isStopCall(status, { status: 'PAUSED' })).toBe(true);
    expect(isStopCall(status, { status: 'LIVE' })).toBe(false);
    expect(isStopCall(capabilityByName('routers.disable_router')!, undefined)).toBe(true);
    expect(isStopCall(capabilityByName('agents.update_agent')!, { name: 'x' })).toBe(false);
  });

  it('stops: a stop value mixed with other edits is not a stop', () => {
    const user = capabilityByName('users.update_user')!;
    const channel = capabilityByName('channels.update_channel')!;
    expect(isStopCall(user, { status: 'DISABLED' })).toBe(true);
    expect(isStopCall(user, { status: 'DISABLED', approval: { checkerId: 'x', reason: 'why' } })).toBe(true);
    expect(isStopCall(user, { status: 'DISABLED', name: undefined })).toBe(true);
    expect(isStopCall(user, { status: 'DISABLED', role: 'HEAD', teamIds: ['t'] })).toBe(false);
    expect(isStopCall(channel, { status: 'DISABLED' })).toBe(true);
    expect(isStopCall(channel, { status: 'DISABLED', name: 'x', settings: {} })).toBe(false);
    expect(isStopCall(channel, {})).toBe(false);
    const stopWhen = CAPABILITIES.filter((c) => c.stopWhen);
    expect(stopWhen.length).toBeGreaterThan(5);
    for (const c of stopWhen) {
      expect(isStopCall(c, { ...c.stopWhen }), c.name).toBe(true);
      expect(isStopCall(c, { ...c.stopWhen, name: 'renamed' }), c.name).toBe(false);
    }
  });

  it('redacts sign-in links from results without touching the input', () => {
    const user = capabilityByName('users.create_user')!;
    const data = { id: 'u', onboarding: { kind: 'invite', expiresAt: 'soon', link: 'https://ocso.example/invite?token=secret' } };
    expect(redactResult(user, data)).toEqual({ id: 'u', onboarding: { kind: 'invite', expiresAt: 'soon' } });
    expect(data.onboarding.link).toContain('token');
    expect(redactResult(user, { id: 'u', onboarding: null })).toEqual({ id: 'u', onboarding: null });
    expect(redactResult({ ...user, redactResponse: ['items.link'] }, { items: [{ link: 'a', id: 1 }, { id: 2 }] })).toEqual({ items: [{ id: 1 }, { id: 2 }] });
    expect(redactResult(capabilityByName('agents.update_agent')!, 'x')).toBe('x');
  });

  it('permissions: all / any / signed-in', () => {
    const has = (held: string[]) => (p: string) => held.includes(p);
    expect(capabilityAllowed(status, has(['agents.pause']))).toBe(true);
    expect(capabilityAllowed(status, has(['agents.read']))).toBe(false);
    expect(capabilityAllowed(capabilityByName('agents.update_agent')!, has(['agents.manage']))).toBe(true);
    expect(capabilityAllowed(capabilityByName('users.list_teams')!, has([]))).toBe(true);
  });

  it('fills paths and validates page links', () => {
    expect(fillPath('/v1/agents/:id/status', { id: 'a b' })).toBe('/v1/agents/a%20b/status');
    expect(fillPath('/v1/agents/:id', {})).toBeNull();
    expect(isAppRoute('/agents/7f1c0a52-0000-4000-8000-000000000000')).toBe(true);
    expect(isAppRoute('/approvals?box=AWAITING_ME')).toBe(true);
    expect(isAppRoute('/login')).toBe(false);
    expect(isAppRoute('https://evil.example/agents/1')).toBe(false);
    expect(isAppRoute('//evil.example/agents')).toBe(false);
    expect(isAppRoute('/agents/../settings')).toBe(false);
  });
});
