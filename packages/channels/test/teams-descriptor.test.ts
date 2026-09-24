import { describe, expect, it } from 'vitest';
import { allowedTeamsServiceUrl, ChannelMediaError, ChannelRegistry, createMsTeamsAdapter, setupFileProblems, TEAMS_CLOUDS } from '../src/index.js';
import { APP_ID, APP_PASSWORD, mtConfig, TENANT, USER_AAD } from './helpers/teams.js';

const adapter = createMsTeamsAdapter();

describe('Teams descriptor', () => {
  const descriptor = adapter.describe();

  it('registers as MS_TEAMS at /channels/ms-teams/<publicKey>/webhook', () => {
    const registry = new ChannelRegistry().register(adapter);
    expect(registry.kindForWebhookSegment('ms-teams')).toBe('MS_TEAMS');
    expect(registry.describe('MS_TEAMS')).toMatchObject({ label: 'Microsoft Teams', mark: { code: 'MT', name: 'Microsoft Teams' }, inboundWebhook: true, embeddable: false, connectionCheck: true, messageTemplates: false });
  });

  it('describes the settings form and the write-only client secret', () => {
    const schema = descriptor.settingsSchema as { properties: Record<string, { default?: unknown; enum?: unknown }>; required?: string[] };
    expect(schema.required).toEqual(['appId']);
    expect(schema.properties['appType']).toMatchObject({ default: 'SingleTenant', enum: ['SingleTenant', 'MultiTenant'] });
    expect(schema.properties['cloud']).toMatchObject({ default: 'public', enum: ['public', 'usgov'] });
    expect(schema.properties).toHaveProperty('tenantId');
    expect(descriptor.secrets.map((s) => [s.key, s.required])).toEqual([['appPassword', true]]);
  });

  it('ships a Teams app manifest whose app and bot id are the Microsoft App ID', () => {
    expect(setupFileProblems(descriptor.setupFiles)).toEqual([]);
    const [file] = descriptor.setupFiles ?? [];
    expect(file).toMatchObject({ key: 'teams-app-manifest', filename: 'manifest.json', contentType: 'application/json' });
    expect(file?.template).not.toContain('appPassword');
    const manifest = JSON.parse((file?.template ?? '').replaceAll('{{settings.appId}}', APP_ID)) as { id: string; manifestVersion: string; bots: Array<{ botId: string; scopes: string[] }> };
    expect(manifest.id).toBe(APP_ID);
    expect(manifest.manifestVersion).toBe('1.17');
    expect(manifest.bots).toEqual([{ botId: APP_ID, scopes: ['personal', 'team', 'groupChat'], supportsFiles: false, isNotificationOnly: false }]);
  });

  it('shows identities by the last characters of the Entra object id', () => {
    expect(adapter.displayIdentity('teams_user', `${TENANT}:${USER_AAD}`)).toBe(`Teams · …${USER_AAD.slice(-6)}`);
    expect(adapter.displayIdentity('slack_user', 'T:U')).toBeNull();
  });

  it('declares text and choice cards only, with no media and no session window', () => {
    const caps = adapter.capabilities(mtConfig());
    expect(caps).toMatchObject({ inboundParts: ['TEXT', 'STRUCTURED'], interactive: true, deliveryReceipts: false, sessionWindowHours: null, identityKinds: ['teams_user'], choices: { buttons: 6, list: 10 } });
    return expect(adapter.fetchMedia({ provider: 'x', ref: 'y' } as never, mtConfig())).rejects.toBeInstanceOf(ChannelMediaError);
  });

  it('answers accepted webhooks with an empty 200', () => {
    expect(adapter.webhookAcknowledgement()).toEqual({ status: 200, contentType: 'text/plain', body: '' });
  });
});

describe('Teams config validation', () => {
  it('accepts a single-tenant and a multi-tenant bot', () => {
    expect(adapter.validateConfig({ appId: APP_ID, tenantId: TENANT }, { appPassword: APP_PASSWORD })).toEqual([]);
    expect(adapter.validateConfig({ appId: APP_ID, appType: 'MultiTenant' }, { appPassword: APP_PASSWORD })).toEqual([]);
  });

  it('names each problem without echoing the secret', () => {
    const problems = adapter.validateConfig({ appId: 'my-bot', appType: 'SingleTenant', cloud: 'mars' }, { appPassword: 'has space secret' });
    expect(problems).toEqual([
      expect.stringMatching(/^settings\.appId: must be the Microsoft App ID/),
      expect.stringMatching(/^settings\.cloud:/),
      expect.stringMatching(/^secrets\.appPassword: must not contain whitespace/),
    ]);
    expect(adapter.validateConfig({ appId: APP_ID }, {})).toEqual(['settings.tenantId: required for a single-tenant bot', 'secrets.appPassword: required']);
    expect(JSON.stringify(problems)).not.toContain('has space secret');
  });

  it('allows endpoint overrides only to a local stub (they move who signs inbound tokens and where secrets go)', () => {
    const ok = { openIdMetadataUrl: 'http://127.0.0.1:9/v1/.well-known/openidconfiguration', tokenUrl: 'https://localhost:9/token', serviceUrlHosts: ['127.0.0.1', 'localhost:3978', '[::1]'] };
    expect(adapter.validateConfig({ appId: APP_ID, tenantId: TENANT, endpoints: ok }, { appPassword: APP_PASSWORD })).toEqual([]);
    const problems = adapter.validateConfig(
      {
        appId: APP_ID,
        tenantId: TENANT,
        endpoints: { openIdMetadataUrl: 'https://keys.attacker.example/openid', tokenUrl: 'https://login.example.com/token', serviceUrlHosts: ['smba.example.com', '*.trafficmanager.net'] },
      },
      { appPassword: APP_PASSWORD },
    );
    expect(problems).toEqual([
      expect.stringMatching(/^settings\.endpoints\.openIdMetadataUrl: must be a local stub/),
      expect.stringMatching(/^settings\.endpoints\.tokenUrl: must be a local stub/),
      expect.stringMatching(/^settings\.endpoints\.serviceUrlHosts\.0: must be a local stub/),
      expect.stringMatching(/^settings\.endpoints\.serviceUrlHosts\.1: must be a local stub/),
    ]);
    expect(adapter.validateConfig({ appId: APP_ID, tenantId: TENANT, endpoints: { tokenUrl: 'http://user:pw@127.0.0.1/token' } }, { appPassword: APP_PASSWORD })[0]).toContain('must be a local stub');
  });
});

describe('Teams service URL allowlist', () => {
  const hosts = TEAMS_CLOUDS.public.serviceUrlHosts;
  it.each([
    ['https://smba.trafficmanager.net/amer/', 'https://smba.trafficmanager.net/amer'],
    ['https://smba.trafficmanager.net/teams', 'https://smba.trafficmanager.net/teams'],
    ['https://directline.botframework.com/', 'https://directline.botframework.com'],
  ])('allows %s', (url, normalized) => {
    expect(allowedTeamsServiceUrl(url, hosts)).toBe(normalized);
  });

  it.each([
    'https://evil.example.com/',
    'https://trafficmanager.net/',
    'https://ocso-exfil.trafficmanager.net/',
    'https://emea.ng.msg.teams.microsoft.com.trafficmanager.net/',
    'https://botframework.com.evil.io/',
    'http://smba.trafficmanager.net/amer/',
    'https://smba.trafficmanager.net:444/amer/',
    'https://a:b@smba.trafficmanager.net/',
    'https://smba.trafficmanager.net/amer/?x=1',
    'https://smba.infra.gcc.teams.microsoft.com/',
    'not a url',
    undefined,
  ])('refuses %s', (url) => {
    expect(allowedTeamsServiceUrl(url, hosts)).toBeNull();
  });

  it('allows loopback http only when a test override names it', () => {
    expect(allowedTeamsServiceUrl('http://127.0.0.1:3978/', hosts)).toBeNull();
    expect(allowedTeamsServiceUrl('http://127.0.0.1:3978/', [...hosts, '127.0.0.1'])).toBe('http://127.0.0.1:3978');
    expect(allowedTeamsServiceUrl('https://stub.internal:8443/x', [...hosts, 'stub.internal:8443'])).toBe('https://stub.internal:8443/x');
  });
});
