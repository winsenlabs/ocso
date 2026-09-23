import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChannelRuntimeConfig, RawHttpRequest } from '@ocso/channels';
import { DomainError, ErrorCategory } from '@ocso/domain';
import { checkPlugin } from '@winsendotai/ocso-plugin-sdk/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIRST_PARTY_PLUGINS, createChannelRegistry, loadConfiguredPlugins, type InstalledPlugin } from '../src/index.js';

/**
 * The SDK example plugin (examples/ocso-plugin-example-channel), built with
 * tsc and installed the way `npm install --prefix <OCSO_PLUGINS_DIR>` leaves
 * it: its package and the SDK it depends on, side by side in node_modules.
 * The loader then imports it through its package.json `exports` and checks
 * it like any installed plugin. The SDK here is a separate copy from the one
 * the repo resolves, so the error marker must be recognised structurally.
 */

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const SDK = { name: '@winsendotai/ocso-plugin-sdk', dir: join(repo, 'packages/ocso-plugin-sdk') };
const EXAMPLE = { name: '@ocso-examples/ocso-plugin-example-channel', dir: join(repo, 'examples/ocso-plugin-example-channel') };
const tsc = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin/tsc');

let pluginsDir = '';
let exampleVersion = '';

/** Builds `pkg` into `<pluginsDir>/node_modules/<name>` (package.json, LICENSE, README and a fresh dist). */
function install(pkg: { name: string; dir: string }): string {
  const target = join(pluginsDir, 'node_modules', pkg.name);
  mkdirSync(target, { recursive: true });
  for (const file of ['package.json', 'README.md', 'LICENSE']) copyFileSync(join(pkg.dir, file), join(target, file));
  // Emit only: both packages are type-checked by their own `typecheck` scripts.
  execFileSync(process.execPath, [tsc, '-p', join(pkg.dir, 'tsconfig.build.json'), '--outDir', join(target, 'dist'), '--noCheck', '--declaration', 'false'], { stdio: 'pipe' });
  return JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).version as string;
}

beforeAll(() => {
  pluginsDir = mkdtempSync(join(tmpdir(), 'ocso-example-plugin-'));
  writeFileSync(join(pluginsDir, 'package.json'), JSON.stringify({ name: 'ocso-plugins', private: true }));
  install(SDK);
  exampleVersion = install(EXAMPLE);
}, 120_000);

afterAll(() => {
  if (pluginsDir) rmSync(pluginsDir, { recursive: true, force: true });
});

const load = (list: string, log?: (line: string) => void) => loadConfiguredPlugins({ env: { OCSO_PLUGINS: list, OCSO_PLUGINS_DIR: pluginsDir }, ...(log ? { log } : {}) });

const config: ChannelRuntimeConfig = { id: 'ch1', kind: 'JSON_WEBHOOK', name: 'Hook', settings: { outboundUrl: 'https://example.com/out' }, secrets: {} };
const post = (body: string): RawHttpRequest => ({ method: 'POST', headers: {}, query: {}, rawBody: Buffer.from(body) });

describe('the SDK example plugin, built and installed', () => {
  it('is accepted by checkPlugin as installed', async () => {
    const entry = join(pluginsDir, 'node_modules', EXAMPLE.name, 'dist/index.js');
    expect(dirname(entry)).toContain(pluginsDir);
    const mod = (await import(/* @vite-ignore */ entry)) as { default: unknown };
    expect(checkPlugin(mod.default)).toEqual([]);
  });

  it('loads through the real loader and registers its channel next to the first-party ones', async () => {
    const lines: string[] = [];
    const loaded = await load(`${EXAMPLE.name}@${exampleVersion}`, (line) => lines.push(line));
    expect(loaded.map((p: InstalledPlugin) => ({ name: p.name, source: p.source, version: p.version }))).toEqual([{ name: EXAMPLE.name, source: 'installed', version: exampleVersion }]);
    expect(lines).toEqual([expect.stringContaining(`loaded plugin ${EXAMPLE.name} from ${EXAMPLE.name}@${exampleVersion}`)]);

    const registry = createChannelRegistry({ fetch: () => Promise.reject(new Error('no network')), now: () => new Date(0) }, [...FIRST_PARTY_PLUGINS, ...loaded]);
    expect(registry.kinds()).toContain('JSON_WEBHOOK');
    expect(registry.describe('JSON_WEBHOOK')).toMatchObject({ kind: 'JSON_WEBHOOK', embeddable: false });
  });

  it('is refused when another version is pinned', async () => {
    await expect(load(`${EXAMPLE.name}@9.9.9`)).rejects.toThrow(`is pinned, but ${exampleVersion} is installed`);
  });

  it('turns its pluginError markers into DomainErrors; successful calls are untouched', async () => {
    const [plugin] = await load(`${EXAMPLE.name}@${exampleVersion}`);
    const adapter = plugin!.channels![0]!({ fetch: () => Promise.reject(new Error('no network')), now: () => new Date(0) });

    let sync: unknown;
    try {
      adapter.verifyRequest(post('{}'), config);
    } catch (e) {
      sync = e;
    }
    expect(sync).toBeInstanceOf(DomainError);
    expect(sync).toMatchObject({ category: ErrorCategory.VALIDATION, code: 'json_webhook_not_configured', message: 'The signing secret is missing' });

    expect(() => adapter.parseInbound(post('not json'), config)).toThrow(DomainError);
    const media = await adapter.fetchMedia({} as never, config).then(
      () => null,
      (e: unknown) => e,
    );
    expect(media).toBeInstanceOf(DomainError);
    expect(media).toMatchObject({ category: ErrorCategory.VALIDATION, code: 'json_webhook_media_unsupported' });

    expect(adapter.parseInbound(post(JSON.stringify({ messages: [{ id: 'm1', from: 'u1', text: 'hi' }] })), config).messages).toHaveLength(1);
    expect(adapter.validateConfig(config.settings, { signingSecret: 'x'.repeat(16) })).toEqual([]);
  });
});
