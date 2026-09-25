import { describe, expect, it } from 'vitest';
import { allowedTeamsServiceUrl, ChannelMediaError, ChannelRegistry, createMsTeamsAdapter, renderSetupFile, setupFileProblems, setupGuideProblems, TEAMS_CLOUDS, TEAMS_MANIFEST_VERSION } from '../src/index.js';

/** Width and height from a PNG's IHDR chunk. */
function pngSize(data: Uint8Array): { width: number; height: number } {
  expect([...data.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
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

  it('ships a Teams app package: manifest (current schema) whose app and bot id are the Microsoft App ID, and both icons', () => {
    expect(setupFileProblems(descriptor.setupFiles)).toEqual([]);
    const [file] = descriptor.setupFiles ?? [];
    expect(file).toMatchObject({ key: 'teams-app-package', filename: 'ocso-teams-app.zip', contentType: 'application/zip' });
    expect(file?.entries?.map((e) => [e.path, e.contentType])).toEqual([
      ['manifest.json', 'application/json'],
      ['color.png', 'image/png'],
      ['outline.png', 'image/png'],
    ]);
    const rendered = renderSetupFile(file!, { webhookUrl: 'https://ocso.example.com/channels/ms-teams/k/webhook', settings: { appId: APP_ID } });
    expect(rendered.missing).toEqual([]);
    const byPath = new Map(rendered.files.map((f) => [f.path, f.data]));
    const manifest = JSON.parse(new TextDecoder().decode(byPath.get('manifest.json'))) as Record<string, unknown> & { bots: unknown[]; developer: Record<string, string> };
    expect(manifest['$schema']).toBe(`https://developer.microsoft.com/json-schemas/teams/v${TEAMS_MANIFEST_VERSION}/MicrosoftTeams.schema.json`);
    expect(manifest['manifestVersion']).toBe(TEAMS_MANIFEST_VERSION);
    expect(manifest['id']).toBe(APP_ID);
    expect(manifest.bots).toEqual([{ botId: APP_ID, scopes: ['personal', 'team', 'groupChat'], supportsFiles: false, isNotificationOnly: false }]);
    expect(manifest['validDomains']).toEqual(['ocso.example.com']);
    expect(manifest.developer['websiteUrl']).toBe('https://ocso.example.com');
    expect(manifest['icons']).toEqual({ color: 'color.png', outline: 'outline.png' });
    expect(JSON.stringify(file)).not.toMatch(/appPassword|secrets\./);
    expect(pngSize(byPath.get('color.png')!)).toEqual({ width: 192, height: 192 });
    expect(pngSize(byPath.get('outline.png')!)).toEqual({ width: 32, height: 32 });
    // Without a saved App ID the package is not ready.
    expect(renderSetupFile(file!, { webhookUrl: 'https://x.example/w', settings: {} }).missing).toEqual(['settings.appId']);
  });

  it('guides the Azure Bot setup step by step, with the messaging endpoint to copy and troubleshooting for the check', () => {
    const guide = descriptor.setupGuide ?? [];
    expect(setupGuideProblems(descriptor)).toEqual([]);
    expect(guide.map((s) => s.title)).toEqual([
      'Create an Azure Bot',
      'Record the Microsoft App ID and the Tenant ID',
      'Create a client secret',
      'Set the messaging endpoint',
      'Add the Microsoft Teams channel',
      'Paste the values into OCSO and save',
      'Download the Teams app package and upload it',
      'Test',
    ]);
    expect(guide[3]?.values).toEqual([{ label: 'Messaging endpoint', value: '{{webhookUrl}}' }]);
    expect(guide.filter((s) => s.form)).toHaveLength(1);
    expect(guide[6]?.files).toEqual(['teams-app-package']);
    expect(descriptor.troubleshooting?.map((t) => t.id)).toEqual(['unauthorized', 'secret-invalid', 'secret-expired', 'custom-apps-blocked', 'no-reply-in-channel', 'endpoint-not-https']);
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
