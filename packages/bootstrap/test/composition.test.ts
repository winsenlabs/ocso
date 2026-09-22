import type { AlertDeliveryAdapter } from '@ocso/alerts';
import type { SettingsService } from '@ocso/application';
import type { ChannelAdapter, ChannelFetch } from '@ocso/channels';
import type { Db } from '@ocso/db';
import { openAiProvider, type ProviderDefinition } from '@ocso/model-providers';
import type { SecretStore } from '@ocso/secrets';
import type { ToolProviderSource } from '@ocso/tools';
import { describe, expect, it } from 'vitest';
import {
  FIRST_PARTY_PLUGINS,
  contributions,
  createAlertDeliveryRegistry,
  createChannelRegistry,
  createProviderRegistry,
  createRuntimeToolRegistry,
  type OcsoPlugin,
} from '../src/index.js';

const offline: ChannelFetch = () => Promise.reject(new Error('no network in unit tests'));

/** A first-party adapter under another kind (a stand-in for a third-party plugin's adapter). */
function renamed(adapter: ChannelAdapter, kind: string): ChannelAdapter {
  return Object.assign(Object.create(adapter) as ChannelAdapter, { kind, describe: () => ({ ...adapter.describe!(), kind }) });
}
const toolDeps = { db: {} as Db, secrets: {} as SecretStore, settings: {} as SettingsService };

describe('composition root (FIRST_PARTY_PLUGINS)', () => {
  it('is one list of uniquely named plugins, one per package', () => {
    const names = FIRST_PARTY_PLUGINS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.startsWith('@ocso/'))).toBe(true);
  });

  it('builds every first-party registry from the list', () => {
    expect(createChannelRegistry({ fetch: offline }).kinds()).toEqual(['TWILIO_WHATSAPP', 'WHATSAPP', 'WEBCHAT']);
    expect(createProviderRegistry({ OCSO_ENABLE_DEV_PROVIDERS: false }).list().map((d) => d.kind)).toEqual([
      'BEDROCK',
      'VERTEX',
      'FOUNDRY',
      'OPENAI',
      'ANTHROPIC',
      'SARVAM',
    ]);
    expect(createProviderRegistry({ OCSO_ENABLE_DEV_PROVIDERS: true }).has('DEV_SCRIPTED')).toBe(true);
    expect(createAlertDeliveryRegistry({ fetch: offline }).kinds()).toEqual(['IN_APP', 'EMAIL', 'SLACK', 'TEAMS', 'WEBHOOK', 'PAGERDUTY']);
    expect(createRuntimeToolRegistry(toolDeps.db, toolDeps.secrets, toolDeps.settings).kinds()).toEqual(['ocso-builtin', 'mcp']);
  });

  it('registers what another plugin contributes, with no change to core code', () => {
    const acmeChannel = (): ChannelAdapter => renamed(createChannelRegistry({ fetch: offline }).get('WEBCHAT'), 'ACME_CHAT');
    const acmeProvider: ProviderDefinition = { ...(openAiProvider as ProviderDefinition), kind: 'ACME_LLM', label: 'Acme LLM' };
    const acmeAlerts = (): AlertDeliveryAdapter => ({ ...createAlertDeliveryRegistry({ fetch: offline }).get('WEBHOOK'), kind: 'ACME_PAGER' });
    const acmeTools = (): ToolProviderSource => ({ kind: 'acme-tools', connectionBacked: false, tools: [], provider: () => Promise.reject(new Error('unused')) });
    const acme: OcsoPlugin = { name: '@acme/ocso-plugin', channels: [acmeChannel], modelProviders: [acmeProvider], alertDestinations: [acmeAlerts], toolProviders: [acmeTools] };
    const plugins = [...FIRST_PARTY_PLUGINS, acme];

    expect(createChannelRegistry({ fetch: offline }, plugins).has('ACME_CHAT')).toBe(true);
    expect(createProviderRegistry({ OCSO_ENABLE_DEV_PROVIDERS: false }, plugins).require('ACME_LLM').label).toBe('Acme LLM');
    expect(createAlertDeliveryRegistry({ fetch: offline }, plugins).has('ACME_PAGER')).toBe(true);
    expect(createRuntimeToolRegistry(toolDeps.db, toolDeps.secrets, toolDeps.settings, plugins).has('acme-tools')).toBe(true);
    // Only what is listed exists.
    expect(createChannelRegistry({ fetch: offline }).has('ACME_CHAT')).toBe(false);
  });

  it('hands channel adapters the host fetch, never the global one', async () => {
    const calls: string[] = [];
    const recording: ChannelFetch = async (input) => {
      calls.push(String(input));
      return new Response('{}', { status: 500 });
    };
    const seen: ChannelFetch[] = [];
    const probe: OcsoPlugin = {
      name: '@acme/probe',
      channels: [
        (deps) => {
          seen.push(deps.fetch);
          return renamed(createChannelRegistry({ fetch: offline }).get('WEBCHAT'), 'PROBE');
        },
      ],
    };
    createChannelRegistry({ fetch: recording }, [probe]);
    expect(seen).toEqual([recording]);
    await seen[0]!('https://example.test/x');
    expect(calls).toEqual(['https://example.test/x']);
  });

  it('refuses a plugin list with a duplicate name or a duplicate kind', () => {
    expect(() => contributions([...FIRST_PARTY_PLUGINS, { name: '@ocso/channels' }], 'channels')).toThrow(/listed twice/);
    expect(() => contributions([{ name: ' ' }], 'channels')).toThrow(/needs a name/);
    const twice: OcsoPlugin = { name: '@acme/again', channels: FIRST_PARTY_PLUGINS.find((p) => p.name === '@ocso/channels')!.channels! };
    expect(() => createChannelRegistry({ fetch: offline }, [...FIRST_PARTY_PLUGINS, twice])).toThrow(/already registered/);
  });
});
