import { NO_NETWORK, type ChannelRuntimeConfig, type RawHttpRequest } from '@ocso/channels';
import { DomainError, ErrorCategory } from '@ocso/domain';
import { EmailSendError } from '@ocso/email';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FIRST_PARTY_PLUGINS,
  createAlertDeliveryRegistry,
  createChannelRegistry,
  createDriverRegistries,
  createProviderRegistry,
  describePlugins,
  loadConfiguredPlugins,
  loadPlugins,
  packageEntry,
  parsePluginList,
  pluginSummary,
  translateEmailPluginError,
  translatePluginError,
  pluginExport,
  type InstalledPlugin,
} from '../src/index.js';
import { ECHO_NAME, echoPackage, pluginsDir, type FixturePackage } from './fixtures/plugins-dir.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function install(...packages: FixturePackage[]): string {
  const { dir, cleanup } = pluginsDir(packages);
  cleanups.push(cleanup);
  return dir;
}

const load = (dir: string, list: string, log?: (line: string) => void) =>
  loadConfiguredPlugins({ env: { OCSO_PLUGINS: list, OCSO_PLUGINS_DIR: dir }, ...(log ? { log } : {}) });

/** The refusal message of a load that must fail. */
async function refusal(dir: string, list: string): Promise<string> {
  const error = await load(dir, list).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toMatch(/^Invalid OCSO plugin configuration \(OCSO_PLUGINS\):/);
  return message;
}

const channelConfig: ChannelRuntimeConfig = { id: 'ch1', kind: 'ECHO', name: 'Echo', settings: {}, secrets: { token: 't' } };
const request = (headers: Record<string, string>): RawHttpRequest => ({ method: 'POST', headers, query: {}, rawBody: null });

describe('OCSO_PLUGINS parsing', () => {
  it('reads name@exactVersion entries, scoped or not', () => {
    expect(parsePluginList(' @acme/ocso-channel-line@1.2.3 , ocso-alerts-x@0.4.0-beta.1 ,')).toEqual({
      pins: [
        { name: '@acme/ocso-channel-line', version: '1.2.3' },
        { name: 'ocso-alerts-x', version: '0.4.0-beta.1' },
      ],
      problems: [],
    });
    expect(parsePluginList(undefined)).toEqual({ pins: [], problems: [] });
  });

  it('refuses ranges, tags, missing versions, bad names and duplicates', () => {
    const { pins, problems } = parsePluginList('a@^1.0.0,b@latest,c,@acme/x,../evil@1.0.0,d@1.0.0,d@1.0.0');
    expect(pins).toEqual([{ name: 'd', version: '1.0.0' }]);
    expect(problems).toEqual([
      'a@^1.0.0: pin an exact version (name@x.y.z); ranges and tags are refused',
      'b@latest: pin an exact version (name@x.y.z); ranges and tags are refused',
      'c: pin an exact version (name@x.y.z); ranges and tags are refused',
      '@acme/x: pin an exact version (name@x.y.z); ranges and tags are refused',
      '../evil@1.0.0: not an npm package name',
      'd is listed twice',
    ]);
  });
});

/** A minimal plugin module body (ESM) for resolution fixtures. */
const esmPlugin = (name: string) => `export default { apiVersion: 1, name: ${JSON.stringify(name)}, channels: [] };\n`;
const pkg = (name: string, manifest: Record<string, unknown>, files: Record<string, string>): FixturePackage => ({ name, version: '1.0.0', manifest, files });

/** The packages the review found Node and the loader disagreeing on, plus the exports shapes Node supports. */
const RESOLUTION_FIXTURES: FixturePackage[] = [
  pkg('@acme/main-extensionless', { main: 'lib/index' }, { 'lib/index.js': esmPlugin('@acme/main-extensionless') }),
  pkg('@acme/main-folder', { main: './lib' }, { 'lib/index.js': esmPlugin('@acme/main-folder') }),
  pkg('@acme/no-main', {}, { 'index.js': esmPlugin('@acme/no-main') }),
  pkg('@acme/missing-main', { main: 'gone.js' }, { 'index.js': esmPlugin('@acme/missing-main') }),
  // TypeScript's CommonJS output of `export default definePlugin(...)`.
  pkg('@acme/ts-cjs', { type: 'commonjs', main: 'dist/index.js' }, {
    'dist/index.js': '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nconst plugin = { apiVersion: 1, name: "@acme/ts-cjs", channels: [] };\nexports.default = plugin;\n',
  }),
  pkg('@acme/exports-nested', { exports: { '.': { types: './d.d.ts', node: { require: './n.cjs', import: './n.js' }, default: './d.js' } } }, {
    'n.js': esmPlugin('@acme/exports-nested'),
    'n.cjs': 'module.exports = {};\n',
    'd.js': 'export default {};\n',
  }),
  pkg('@acme/exports-array', { exports: { '.': [{ worker: './w.js' }, './a.js'] } }, { 'a.js': esmPlugin('@acme/exports-array') }),
  pkg('@acme/exports-sugar', { exports: { import: './c.js', require: './c.cjs' } }, { 'c.js': esmPlugin('@acme/exports-sugar') }),
  pkg('@acme/exports-default-only', { exports: { '.': { require: './r.cjs', default: './d.js' } } }, { 'd.js': esmPlugin('@acme/exports-default-only') }),
];
const RESOLVABLE = ['main-extensionless', 'main-folder', 'no-main', 'missing-main', 'ts-cjs', 'exports-nested', 'exports-array', 'exports-sugar', 'exports-default-only'].map((n) => `@acme/${n}`);

/** What plain `node` (no vitest, no tsx) does for `import('<name>')` from OCSO_PLUGINS_DIR: the resolved file and the module namespace. */
function plainNode(dir: string, names: readonly string[]): Record<string, { entry: string; mod: Record<string, unknown> }> {
  const probe = join(dir, 'probe.mjs');
  writeFileSync(
    probe,
    [
      "import { fileURLToPath } from 'node:url';",
      'const out = {};',
      'for (const name of JSON.parse(process.argv[2])) {',
      '  const url = import.meta.resolve(name);',
      '  out[name] = { entry: fileURLToPath(url), mod: JSON.parse(JSON.stringify(await import(url))) };',
      '}',
      'process.stdout.write(JSON.stringify(out));',
    ].join('\n'),
  );
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NODE_') && !k.startsWith('VITEST')));
  return JSON.parse(execFileSync(process.execPath, ['--no-deprecation', probe, JSON.stringify(names)], { cwd: dir, env, encoding: 'utf8' })) as Record<string, { entry: string; mod: Record<string, unknown> }>;
}

describe('package entry resolution (as Node resolves import())', () => {
  const manifest = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8')) as Record<string, unknown>;

  it('resolves every fixture to the file plain node imports, and picks up the plugin export node hands over', () => {
    const dir = install(...RESOLUTION_FIXTURES);
    const node = plainNode(dir, RESOLVABLE);
    for (const name of RESOLVABLE) {
      expect(packageEntry(manifest(dir, name), join(dir, 'node_modules', name)), name).toBe(node[name]!.entry);
      expect(pluginExport(node[name]!.mod), name).toMatchObject({ apiVersion: 1, name });
    }
    const real = realpathSync(join(dir, 'node_modules'));
    expect(node['@acme/main-extensionless']!.entry).toBe(join(real, '@acme/main-extensionless/lib/index.js'));
    expect(node['@acme/main-folder']!.entry).toBe(join(real, '@acme/main-folder/lib/index.js'));
    expect(node['@acme/missing-main']!.entry).toBe(join(real, '@acme/missing-main/index.js'));
    expect(node['@acme/exports-nested']!.entry).toBe(join(real, '@acme/exports-nested/n.js'));
    // TypeScript's CommonJS default export arrives under plain node as default.default.
    expect(node['@acme/ts-cjs']!.mod).toMatchObject({ default: { default: { apiVersion: 1 } } });
  });

  it('loads those packages through OCSO_PLUGINS', async () => {
    const dir = install(...RESOLUTION_FIXTURES);
    expect((await load(dir, RESOLVABLE.map((n) => `${n}@1.0.0`).join(','))).map((p) => p.name)).toEqual(RESOLVABLE);
  });

  it('refuses an entry outside the package (exports, main, or a symlink), a missing one, and no import entry', async () => {
    const dir = install(
      pkg('@acme/exports-escape', { exports: { '.': { import: '../../other/index.js' } } }, {}),
      pkg('@acme/exports-bare', { exports: { '.': 'index.js' } }, { 'index.js': esmPlugin('@acme/exports-bare') }),
      pkg('@acme/main-escape', { main: '../outside.js' }, {}),
      pkg('@acme/linked', { exports: './link.js' }, {}),
      pkg('@acme/exports-missing', { exports: './gone.js' }, {}),
      pkg('@acme/require-only', { exports: { '.': { require: './a.cjs' } } }, { 'a.cjs': 'module.exports = {};\n' }),
      pkg('@acme/import-null', { exports: { '.': { import: null, default: './d.js' } } }, { 'd.js': esmPlugin('@acme/import-null') }),
      pkg('@acme/mixed', { exports: { '.': './a.js', import: './b.js' } }, { 'a.js': esmPlugin('@acme/mixed') }),
    );
    writeFileSync(join(dir, 'outside.js'), esmPlugin('outside'));
    symlinkSync(join(dir, 'outside.js'), join(dir, 'node_modules', '@acme/linked', 'link.js'));
    const names = ['exports-escape', 'exports-bare', 'main-escape', 'linked', 'exports-missing', 'require-only', 'import-null', 'mixed'];
    const message = await refusal(dir, names.map((n) => `@acme/${n}@1.0.0`).join(','));
    expect(message).toContain('@acme/exports-escape@1.0.0 could not be loaded: its entry ../../other/index.js points outside the package');
    expect(message).toContain('@acme/exports-bare@1.0.0 could not be loaded: its entry index.js points outside the package');
    expect(message).toContain('@acme/main-escape@1.0.0 could not be loaded: its entry ../outside.js points outside the package');
    expect(message).toContain('@acme/linked@1.0.0 could not be loaded: its entry ./link.js points outside the package');
    expect(message).toContain('@acme/exports-missing@1.0.0 could not be loaded: its entry ./gone.js (package.json "exports") does not exist');
    expect(message).toContain('@acme/require-only@1.0.0 could not be loaded: its package.json "exports" has no import entry for "."');
    expect(message).toContain('@acme/import-null@1.0.0 could not be loaded: its package.json "exports" has no import entry for "."');
    expect(message).toContain('@acme/mixed@1.0.0 could not be loaded: its package.json "exports" mixes subpaths and conditions');
  });
});

describe('plugin loader', () => {
  it('loads nothing, and touches no folder, when OCSO_PLUGINS is unset or empty', async () => {
    expect(await loadConfiguredPlugins({ env: { OCSO_PLUGINS_DIR: '/nonexistent' } })).toEqual([]);
    expect(await loadConfiguredPlugins({ env: { OCSO_PLUGINS: ' , ' } })).toEqual([]);
    expect((await loadPlugins({ env: {} })).map((p) => p.name)).toEqual(FIRST_PARTY_PLUGINS.map((p) => p.name));
  });

  it('loads a pinned plugin and every registry sees its contributions', async () => {
    const dir = install(echoPackage({ version: '1.2.3' }));
    const lines: string[] = [];
    const [echo, ...rest] = await load(dir, `${ECHO_NAME}@1.2.3`, (line) => lines.push(line));
    expect(rest).toEqual([]);
    expect(echo).toMatchObject({ name: ECHO_NAME, version: '1.2.3', source: 'installed', packageName: ECHO_NAME });
    expect(lines).toEqual([`loaded plugin ${ECHO_NAME} from ${ECHO_NAME}@1.2.3 (${dir})`]);

    const plugins = await loadPlugins({ env: { OCSO_PLUGINS: `${ECHO_NAME}@1.2.3`, OCSO_PLUGINS_DIR: dir } });
    expect(plugins.at(-1)?.name).toBe(ECHO_NAME);
    const channels = createChannelRegistry({ fetch: NO_NETWORK }, plugins);
    expect(channels.kinds().at(-1)).toBe('ECHO');
    expect(channels.describe('ECHO')).toMatchObject({ label: 'Echo (test)', mark: { code: 'EC' }, connectionCheck: false, messageTemplates: false });
    expect(channels.webhookPath('ECHO', 'pk_1')).toBe('/channels/echo/pk_1/webhook');
    expect(createProviderRegistry({ OCSO_ENABLE_DEV_PROVIDERS: false }, plugins).require('ECHO_LLM').label).toBe('Echo LLM (test)');
    expect(createAlertDeliveryRegistry({ fetch: NO_NETWORK }, plugins).receives('ECHO_ALERT', 'OPENED')).toBe(true);
    expect(createDriverRegistries(plugins).email.names()).toContain('echo-mail');
  });

  it('describes first-party and installed plugins with versions', async () => {
    const dir = install(echoPackage({ version: '1.2.3' }));
    const plugins = await loadPlugins({ env: { OCSO_PLUGINS: `${ECHO_NAME}@1.2.3`, OCSO_PLUGINS_DIR: dir } });
    const info = describePlugins(plugins, '2026.9.0');
    expect(info.find((p) => p.name === '@ocso/channels')).toEqual({
      name: '@ocso/channels',
      version: '2026.9.0',
      source: 'first-party',
      contributes: { channels: ['TWILIO_WHATSAPP', 'WHATSAPP', 'WEBCHAT'], modelProviders: [], alertDestinations: [], emailDrivers: [] },
      internal: [],
    });
    expect(info.find((p) => p.name === '@ocso/blob')?.internal).toEqual(['blob drivers: local, s3']);
    expect(info.at(-1)).toEqual({
      name: ECHO_NAME,
      version: '1.2.3',
      source: 'installed',
      contributes: { channels: ['ECHO'], modelProviders: ['ECHO_LLM'], alertDestinations: ['ECHO_ALERT'], emailDrivers: ['echo-mail'] },
      internal: [],
    });
    const summary = pluginSummary(plugins, '2026.9.0');
    expect(summary).toContain('first-party @ocso/channels@2026.9.0, ');
    expect(summary).toMatch(new RegExp(`installed ${ECHO_NAME}@1\\.2\\.3$`));
  });

  it('refuses a version that differs from the pin', async () => {
    const dir = install(echoPackage({ version: '1.0.1' }));
    expect(await refusal(dir, `${ECHO_NAME}@1.0.0`)).toContain(`${ECHO_NAME}@1.0.0 is pinned, but 1.0.1 is installed in ${dir}`);
  });

  it('refuses a plugin that is not installed, naming the install command', async () => {
    const dir = install();
    expect(await refusal(dir, 'ocso-missing@2.0.0')).toContain(`ocso-missing@2.0.0 is not installed in ${dir} (npm install --prefix ${dir} ocso-missing@2.0.0)`);
  });

  it('refuses another plugin API version, or none', async () => {
    const dir = install(echoPackage({ override: '{ apiVersion: 2 }' }), echoPackage({ name: '@acme/no-version', override: '{ apiVersion: undefined }' }));
    const message = await refusal(dir, `${ECHO_NAME}@1.0.0,@acme/no-version@1.0.0`);
    expect(message).toContain(`${ECHO_NAME}@1.0.0 is built for plugin API version 2; this OCSO runs plugin API version 1`);
    expect(message).toContain('@acme/no-version@1.0.0 declares no apiVersion');
  });

  it('refuses a module without a plugin export, and one that fails to import', async () => {
    const dir = install(
      { name: 'ocso-empty', version: '1.0.0', manifest: { exports: './index.js' }, files: { 'index.js': 'export const nothing = 1;\n' } },
      { name: 'ocso-broken', version: '1.0.0', manifest: { exports: './index.js' }, files: { 'index.js': "throw new Error('top-level failure');\n" } },
    );
    const message = await refusal(dir, 'ocso-empty@1.0.0,ocso-broken@1.0.0');
    expect(message).toContain('ocso-empty@1.0.0 exports no plugin');
    expect(message).toContain('ocso-broken@1.0.0 could not be loaded: top-level failure');
  });

  it('loads a CommonJS plugin exported as `plugin`, or as module.exports', async () => {
    const cjs = (name: string, body: string): FixturePackage => ({
      name,
      version: '1.0.0',
      manifest: { type: 'commonjs', main: 'index.js' },
      files: { 'index.js': `const channels = [];\n${body}\n` },
    });
    const dir = install(
      cjs('@acme/cjs-named', "exports.plugin = { apiVersion: 1, name: '@acme/cjs-named', channels };"),
      cjs('@acme/cjs-default', "module.exports = { apiVersion: 1, name: '@acme/cjs-default', channels };"),
    );
    expect((await load(dir, '@acme/cjs-named@1.0.0,@acme/cjs-default@1.0.0')).map((p) => p.name)).toEqual(['@acme/cjs-named', '@acme/cjs-default']);
    const plugin = { apiVersion: 1 };
    expect(pluginExport({ default: plugin })).toBe(plugin);
    expect(pluginExport({ plugin })).toBe(plugin);
    expect(pluginExport({ default: { plugin } })).toBe(plugin);
    expect(pluginExport({ default: { name: 'x' } })).toEqual({ name: 'x' });
    // TypeScript's CommonJS `exports.default = plugin` (with __esModule), as plain node imports it.
    expect(pluginExport({ default: { __esModule: true, default: plugin } })).toBe(plugin);
  });

  it('refuses names that clash with a first-party plugin, another installed plugin, or the @ocso scope', async () => {
    const dir = install(
      echoPackage({ name: '@acme/a', override: "{ name: '@ocso/channels' }" }),
      echoPackage({ name: '@acme/b', override: "{ name: 'shared', channels: [], modelProviders: [], alertDestinations: [], emailDrivers: [] }" }),
      echoPackage({ name: '@acme/c', override: "{ name: 'shared', channels: [], modelProviders: [], alertDestinations: [], emailDrivers: [] }" }),
      echoPackage({ name: '@acme/d', override: "{ name: '@ocso/extra' }" }),
    );
    const message = await refusal(dir, '@acme/a@1.0.0,@acme/b@1.0.0,@acme/c@1.0.0,@acme/d@1.0.0');
    expect(message).toContain('@acme/a@1.0.0 is named @ocso/channels, which is already taken');
    expect(message).not.toContain('@acme/b@1.0.0');
    expect(message).toContain('@acme/c@1.0.0 is named shared, which is already taken');
    expect(message).toContain('@acme/d@1.0.0 is named @ocso/extra; the @ocso/ scope is reserved');
  });

  it('refuses contributions the registries refuse, and internal contribution kinds', async () => {
    const renamedChannel = (fields: string) => `{ channels: [(deps) => { const a = base.channels[0](deps); return { ...a, ${fields} }; }] }`;
    const dir = install(
      echoPackage({ name: '@acme/lower', override: renamedChannel("kind: 'echo', describe: () => ({ ...base.channels[0](deps).describe(), kind: 'echo' })") }),
      echoPackage({ name: '@acme/clash', override: renamedChannel("kind: 'WEBCHAT', describe: () => ({ ...base.channels[0](deps).describe(), kind: 'WEBCHAT' })") }),
      echoPackage({ name: '@acme/embed', override: renamedChannel("describe: () => ({ ...base.channels[0](deps).describe(), embeddable: true })") }),
      echoPackage({ name: '@acme/events', override: "{ channels: [], alertDestinations: [() => ({ ...base.alertDestinations[0](), events: ['EXPLODED'] })] }" }),
      echoPackage({ name: '@acme/driver', override: "{ channels: [], alertDestinations: [], modelProviders: [], emailDrivers: [{ ...base.emailDrivers[0], name: 'Echo_Mail' }] }" }),
      echoPackage({ name: '@acme/provider', override: "{ channels: [], alertDestinations: [], emailDrivers: [], modelProviders: [{ ...base.modelProviders[0], kind: 'OPENAI' }] }" }),
      echoPackage({ name: '@acme/tools', override: '{ toolProviders: [() => ({})], channels: {} }' }),
    );
    const message = await refusal(dir, ['lower', 'clash', 'embed', 'events', 'driver', 'provider', 'tools'].map((n) => `@acme/${n}@1.0.0`).join(','));
    expect(message).toContain('@acme/lower@1.0.0 has an invalid contribution: invalid channel kind "echo"');
    expect(message).toContain('@acme/clash@1.0.0 has an invalid contribution: channel adapter WEBCHAT already registered');
    expect(message).toContain('@acme/embed@1.0.0 has an invalid contribution: channel adapter ECHO: embeddable kinds (and only they) implement the embed hooks');
    expect(message).toContain('@acme/events@1.0.0 has an invalid contribution: alert delivery adapter ECHO_ALERT must receive known lifecycle events');
    expect(message).toContain('@acme/driver@1.0.0 has an invalid contribution: email driver name "Echo_Mail" must be lower case');
    expect(message).toContain('@acme/provider@1.0.0 has an invalid contribution: Provider OPENAI is already registered');
    expect(message).toContain('@acme/tools@1.0.0 contributes toolProviders, which installed plugins cannot contribute in plugin API v1');
    expect(message).toContain('@acme/tools@1.0.0 channels must be an array');
  });

  it('refuses a clash between two installed plugins’ kinds', async () => {
    const dir = install(echoPackage({ name: '@acme/one' }), echoPackage({ name: '@acme/two', override: "{ name: '@acme/two' }" }));
    const message = await refusal(dir, '@acme/one@1.0.0,@acme/two@1.0.0');
    // @acme/one's export is named @acme/ocso-plugin-echo; @acme/two contributes the same kinds under another name.
    expect(message).toContain('@acme/two@1.0.0 has an invalid contribution: channel adapter ECHO already registered');
  });
});

describe('plugin errors (SDK marker) at the plugin boundary', () => {
  async function echo(): Promise<InstalledPlugin> {
    const dir = install(echoPackage());
    const [plugin] = await load(dir, `${ECHO_NAME}@1.0.0`);
    return plugin!;
  }

  const rejection = (promise: Promise<unknown>) => promise.then(() => null, (e: unknown) => e);
  const thrown = (fn: () => unknown) => {
    try {
      fn();
      return null;
    } catch (e) {
      return e;
    }
  };

  it('translates marked channel errors (sync and async) into DomainError; other errors pass through unchanged', async () => {
    const adapter = (await echo()).channels![0]!({ fetch: NO_NETWORK, now: () => new Date(0) });
    const sync = thrown(() => adapter.verifyRequest(request({}), channelConfig));
    expect(sync).toBeInstanceOf(DomainError);
    expect(sync).toMatchObject({ category: ErrorCategory.AUTHENTICATION, code: 'echo_token_missing', message: 'The echo token is missing', details: { header: 'x-echo-token' } });
    expect((sync as Error & { cause?: unknown }).cause).toMatchObject({ name: 'OcsoPluginError' });

    const plain = thrown(() => adapter.verifyRequest(request({ 'x-echo-token': 'boom' }), channelConfig));
    expect(plain).not.toBeInstanceOf(DomainError);
    expect(plain).toMatchObject({ message: 'plain failure' });

    const media = await rejection(adapter.fetchMedia({} as never, channelConfig));
    expect(media).toBeInstanceOf(DomainError);
    expect(media).toMatchObject({ category: ErrorCategory.NOT_FOUND, code: 'echo_media_missing' });

    // Successful calls, and reads, are untouched (the adapter itself is frozen).
    expect(adapter.verifyRequest(request({ 'x-echo-token': 'ok' }), channelConfig)).toEqual({ kind: 'verified' });
    expect(await adapter.send({} as never, { kind: 'ECHO', payload: {}, partIndexes: [0, 1] }, channelConfig, {} as never)).toEqual({ ok: true, externalMessageId: 'echo-0-2' });
    expect(adapter.kind).toBe('ECHO');
    expect({ ...adapter }.kind).toBe('ECHO');
    expect('embed' in adapter).toBe(false);
    expect(adapter.send).toBe(adapter.send);
  });

  it('translates alert, email and model provider errors, including a failing stream', async () => {
    const plugin = await echo();
    const alerts = plugin.alertDestinations![0]!({ fetch: NO_NETWORK, mailTransport: () => ({}) as never, emailSender: null });
    const alertError = await rejection(alerts.deliver({} as never, {}, null));
    expect(alertError).toMatchObject({ category: ErrorCategory.PROVIDER_UNAVAILABLE, code: 'echo_alert_down' });
    expect((alertError as DomainError).retriable).toBe(true);

    const sender = plugin.emailDrivers![0]!.create({}, { from: 'ops@example.com', replyTo: null }, {} as never);
    expect(sender.from).toBe('ops@example.com');
    const throttled = await rejection(sender.send({ to: 'a@example.com', subject: 's', html: '', text: '' }));
    expect(throttled).toBeInstanceOf(EmailSendError);
    expect(throttled).toMatchObject({ message: 'Echo mail is throttled', category: 'rate_limited', retriable: true, status: null });
    expect((throttled as Error & { cause?: unknown }).cause).toMatchObject({ name: 'OcsoPluginError' });

    const provider = plugin.modelProviders![0]!;
    const adapter = provider.create({ id: 'p1', kind: 'ECHO_LLM', name: 'Echo', region: null, residencyZone: null, settings: {}, credentials: {} } as never, { media: {} as never });
    expect(adapter.providerId).toBe('p1');
    expect(await rejection(adapter.generate({} as never, 'm'))).toMatchObject({ category: ErrorCategory.PROVIDER_UNAVAILABLE, code: 'echo_llm_down' });
    const events: unknown[] = [];
    const streamError = await rejection(
      (async () => {
        for await (const event of adapter.stream({} as never, 'm')) events.push(event);
      })(),
    );
    expect(events).toEqual([{ type: 'text-delta', text: 'hel' }]);
    expect(streamError).toBeInstanceOf(DomainError);
    expect(streamError).toMatchObject({ category: ErrorCategory.TIMEOUT, code: 'echo_stream_timeout' });
  });
});

describe('email driver errors on a core path', () => {
  const at = '2026-09-23T00:00:00.000Z';
  const alert = {
    alertId: 'a1', deliveryId: 'd1', event: 'OPENED', fingerprint: 'f', ruleId: null, ruleName: null, condition: null, kind: 'TECHNICAL',
    severity: 'CRITICAL', status: 'OPEN', title: 'Disk full', body: 'The disk is full', value: null, source: 'test', context: {},
    occurrences: 1, openedAt: at, lastSeenAt: at, acknowledgedAt: null, resolvedAt: null, resolution: null, link: null, deployment: 'OCSO',
  } as never;

  it('marked sender errors reach core email callers as EmailSendError, with category and retriability', async () => {
    const dir = install(echoPackage());
    const [plugin] = await load(dir, `${ECHO_NAME}@1.0.0`);
    const sender = plugin!.emailDrivers![0]!.create({}, { from: 'ops@example.com', replyTo: null }, {} as never);
    const mail = (to: string) => sender.send({ to, subject: 's', html: '', text: '' }).then(() => null, (e: unknown) => e);

    const rejected = await mail('reject@example.com');
    expect(rejected).toBeInstanceOf(EmailSendError);
    expect(rejected).toMatchObject({ message: 'Echo mail rejected the API key', category: 'auth', retriable: false, status: 401 });
    const plain = await mail('plain@example.com');
    expect(plain).not.toBeInstanceOf(EmailSendError);
    expect(plain).toMatchObject({ message: 'echo mail plain failure' });

    // The alert EMAIL destination (deployment transport) is one of the core callers that only reads EmailSendError.
    const email = createAlertDeliveryRegistry({ fetch: NO_NETWORK, mailTransport: () => ({}) as never, emailSender: sender }, FIRST_PARTY_PLUGINS).get('EMAIL');
    const deliver = (to: string) => email.deliver(alert, { transport: 'deployment', to: [to] }, null);
    expect(await deliver('reject@example.com')).toEqual({ ok: false, retriable: false, error: 'Echo mail rejected the API key' });
    expect(await deliver('a@example.com')).toEqual({ ok: false, retriable: true, error: 'Echo mail is throttled' });
    expect(await deliver('plain@example.com')).toEqual({ ok: false, retriable: true, error: 'email send failed' });
  });

  it('maps every host category onto an email category', () => {
    const marked = (category: string) => Object.defineProperty(new Error('m'), 'ocsoError', { value: { category, code: 'c' } });
    const cases: Array<[string, string, boolean]> = [
      ['authorization', 'auth', false],
      ['validation', 'validation', false],
      ['policy_denied', 'validation', false],
      ['capacity', 'rate_limited', true],
      ['provider_unavailable', 'unavailable', true],
      ['tool_unavailable', 'unavailable', true],
      ['timeout', 'network', true],
      ['internal', 'unknown', false],
      ['not_found', 'unknown', false],
    ];
    for (const [category, email, retriable] of cases) {
      expect(translateEmailPluginError(marked(category))).toMatchObject({ name: 'EmailSendError', category: email, retriable });
    }
    const already = new EmailSendError('x', false, 400, 'validation');
    expect(translateEmailPluginError(already)).toBe(already);
  });
});

describe('translatePluginError', () => {
  const marked = (marker: unknown) => Object.defineProperty(new Error('m'), 'ocsoError', { value: marker });

  it('keeps DomainErrors and unmarked or malformed errors as they are', () => {
    const domain = new DomainError(ErrorCategory.CONFLICT, 'c', 'm');
    expect(translatePluginError(domain)).toBe(domain);
    for (const error of [new Error('x'), 'text', null, marked({ category: 'exploded', code: 'x' }), marked({ category: 'validation', code: '' }), marked({ category: 'validation', code: 'c', details: 'no' })]) {
      expect(translatePluginError(error)).toBe(error);
    }
  });

  it('translates a well-formed marker, whichever copy of the SDK made it', () => {
    const translated = translatePluginError(marked({ category: 'validation', code: 'bad_input', details: { field: 'x' } }));
    expect(translated).toBeInstanceOf(DomainError);
    expect(translated).toMatchObject({ category: 'validation', code: 'bad_input', message: 'm', details: { field: 'x' } });
  });
});
