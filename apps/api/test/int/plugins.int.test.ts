import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InfrastructureModule, loadApiPlugins } from '../../src/infrastructure/infrastructure.module.js';
import { loadSeedPlugins } from '../../src/seed/context.js';
import { completeSetup, startApi, type ApiHarness } from './harness.js';
import { liveChannel, platformChecker, type Checker } from './platform.js';

/**
 * Installed plugins end to end (docs/guides/extending/install-a-plugin.md): the api loads a
 * plugin pinned in OCSO_PLUGINS from OCSO_PLUGINS_DIR, serves it in
 * GET /v1/system/plugins and the kinds endpoints, runs its channel, and turns
 * the SDK's error marker into a typed HTTP error.
 */
const NAME = '@acme/ocso-channel-echo';
const VERSION = '0.3.1';

// A plugin as the SDK builds it: ESM, default export { apiVersion: 1, name, channels }, marked errors.
const PLUGIN_SOURCE = `
const pluginError = (category, code, message, details) =>
  Object.defineProperty(new Error(message), 'ocsoError', { value: { category, code, details }, enumerable: false });
const createEcho = () => ({
  kind: 'ECHO',
  describe: () => ({
    kind: 'ECHO', label: 'Echo', description: 'Test channel', mark: { code: 'EC', name: 'Echo' },
    settingsSchema: { type: 'object', properties: {} }, secrets: [], setupSteps: [], inboundWebhook: true, embeddable: false,
  }),
  capabilities: () => ({}),
  validateConfig: () => [],
  verifyRequest(req) {
    if (req.headers['x-echo'] === 'plain') throw new Error('unmarked failure');
    if (!req.headers['x-echo']) throw pluginError('authentication', 'echo_signature_missing', 'The echo signature is missing', { header: 'x-echo' });
    return { kind: 'verified' };
  },
  parseInbound: () => ({ messages: [], statuses: [], ignored: 1 }),
  fetchMedia: async () => { throw pluginError('not_found', 'echo_media', 'none'); },
  render: () => [],
  send: async () => ({ ok: true, externalMessageId: 'echo' }),
});
export default { apiVersion: 1, name: '${NAME}', channels: [createEcho] };
`;

let h: ApiHarness;
let admin: string;
let checker: Checker;
let pluginsDir: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  pluginsDir = mkdtempSync(join(tmpdir(), 'ocso-plugins-int-'));
  const root = join(pluginsDir, 'node_modules', NAME);
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: NAME, version: VERSION, type: 'module', exports: { '.': { import: './dist/index.js' } } }));
  writeFileSync(join(root, 'dist/index.js'), PLUGIN_SOURCE);
  h = await startApi({ env: { OCSO_PLUGINS: `${NAME}@${VERSION}`, OCSO_PLUGINS_DIR: pluginsDir, APP_VERSION: '9.9.9-test' } });
  admin = await completeSetup(h);
  checker = await platformChecker(h);
});
afterAll(async () => {
  await h?.close();
  delete process.env['OCSO_PLUGINS'];
  delete process.env['OCSO_PLUGINS_DIR'];
  delete process.env['APP_VERSION'];
  if (pluginsDir) rmSync(pluginsDir, { recursive: true, force: true });
});

/** process.env with OCSO_PLUGINS replaced while `fn` runs. */
async function withPluginList<T>(list: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env['OCSO_PLUGINS'];
  process.env['OCSO_PLUGINS'] = list;
  try {
    return await fn();
  } finally {
    process.env['OCSO_PLUGINS'] = saved;
  }
}

describe('plugin list at start-up', () => {
  it('logs the loaded list with versions (the line the worker logs too)', async () => {
    // The PLUGINS provider's factory (it logs through Nest's Logger('Plugins') by default).
    const lines: string[] = [];
    const plugins = await loadApiPlugins((line) => lines.push(line));
    expect(plugins.at(-1)).toMatchObject({ name: NAME, version: VERSION });
    expect(lines).toEqual([expect.stringMatching(new RegExp(`^plugins: first-party @ocso/channels@9\\.9\\.9-test, .*; installed ${NAME}@0\\.3\\.1$`))]);
  });

  it('refuses to start when the installed version differs from the pin (the PLUGINS provider rejects)', async () => {
    const boot = withPluginList(`${NAME}@0.3.2`, () => NestFactory.createApplicationContext(InfrastructureModule, { logger: false, abortOnError: false }));
    await expect(boot).rejects.toThrow(`${NAME}@0.3.2 is pinned, but ${VERSION} is installed in ${pluginsDir}`);
  });

  it('refuses to start on a malformed list', async () => {
    const boot = withPluginList(`${NAME}@^0.3.1`, () => NestFactory.createApplicationContext(InfrastructureModule, { logger: false, abortOnError: false }));
    await expect(boot).rejects.toThrow(/Invalid OCSO plugin configuration \(OCSO_PLUGINS\):\n {2}- .*pin an exact version/);
  });

  it('the demo seed loads and logs the same list, and fails on a bad one', async () => {
    const lines: string[] = [];
    const plugins = await loadSeedPlugins(process.env, (line) => lines.push(line));
    expect(plugins[0]?.name).toBe('@ocso/channels');
    expect(plugins.at(-1)).toMatchObject({ name: NAME, source: 'installed', version: VERSION });
    expect(lines).toEqual([expect.stringMatching(new RegExp(`installed ${NAME}@0\\.3\\.1$`))]);
    await expect(loadSeedPlugins({ ...process.env, OCSO_PLUGINS: `${NAME}@9.0.0` }, () => {})).rejects.toThrow(`${NAME}@9.0.0 is pinned, but ${VERSION} is installed`);
  });
});

describe('installed plugins', () => {
  it('lists first-party and installed plugins with versions and contributions (system.read)', async () => {
    const res = await h.http().get('/v1/system/plugins').set(auth(admin)).expect(200);
    const plugins = res.body as Array<{ name: string; version: string; source: string; contributes: Record<string, string[]> }>;
    expect(plugins.find((p) => p.name === '@ocso/channels')).toMatchObject({ version: '9.9.9-test', source: 'first-party', contributes: { channels: ['TWILIO_WHATSAPP', 'WHATSAPP', 'WEBCHAT', 'SLACK', 'MS_TEAMS'] } });
    expect(plugins.find((p) => p.name === '@ocso/email')?.contributes.emailDrivers).toEqual(expect.arrayContaining(['log']));
    expect(plugins.at(-1)).toEqual({
      name: NAME,
      version: VERSION,
      source: 'installed',
      contributes: { channels: ['ECHO'], modelProviders: [], alertDestinations: [], emailDrivers: [] },
      internal: [],
    });
  });

  it('needs a session and system.read', async () => {
    await h.http().get('/v1/system/plugins').expect(401);
    await h.http().post('/v1/users').set(auth(admin)).send({ email: 'plugins-lead@ocso.test', name: 'Lead', role: 'LEAD', password: 'a password 12345' }).expect(201);
    const lead = await h.loginAs('plugins-lead@ocso.test', 'a password 12345');
    await h.http().get('/v1/system/plugins').set(auth(lead)).expect(403);
  });

  it('serves the installed channel kind to the admin form', async () => {
    const res = await h.http().get('/v1/channels/kinds').set(auth(admin)).expect(200);
    expect(res.body.map((k: { kind: string }) => k.kind)).toEqual(['TWILIO_WHATSAPP', 'WHATSAPP', 'WEBCHAT', 'SLACK', 'MS_TEAMS', 'ECHO']);
  });

  it('turns a marked plugin error into a typed error response; unmarked ones stay internal', async () => {
    const channel = await liveChannel<{ id: string; publicKey: string }>(h, admin, checker, { kind: 'ECHO', name: 'Echo desk', settings: {} });
    const path = `/channels/echo/${channel.publicKey}/webhook`;
    const refused = await h.http().post(path).send({}).expect(401);
    expect(refused.body.error).toMatchObject({ category: 'authentication', code: 'echo_signature_missing', message: 'The echo signature is missing', details: { header: 'x-echo' } });
    const plain = await h.http().post(path).set('x-echo', 'plain').send({}).expect(500);
    expect(plain.body.error).toMatchObject({ category: 'internal', code: 'internal_error' });
    await h.http().post(path).set('x-echo', 'signed').send({}).expect(200);
  });
});
