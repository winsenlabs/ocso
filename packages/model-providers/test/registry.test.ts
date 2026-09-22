import { describe, expect, it } from 'vitest';
import { PROVIDER_KIND_PATTERN } from '../src/contract/types.js';
import { promptCachingOf, type ProviderDefinition } from '../src/providers/definition.js';
import { devScriptedProvider } from '../src/providers/dev-scripted/definition.js';
import { foundryProvider } from '../src/providers/foundry/definition.js';
import { sarvamProvider } from '../src/providers/sarvam/definition.js';
import { createDefaultRegistry, createRegistry, FIRST_PARTY_PROVIDERS, PRODUCTION_PROVIDERS, ProviderRegistry } from '../src/registry.js';
import { media, runtimeConfig } from './support/requests.js';

/** A provider this package does not ship: registering it must need nothing but the definition. */
const mistralLike: ProviderDefinition = { ...sarvamProvider, kind: 'MISTRAL', label: 'Mistral AI', mark: 'MIS', cachingSummary: 'none documented', catalog: undefined };

describe('ProviderRegistry', () => {
  it('registers the six production providers and no dev provider by default', () => {
    const registry = createDefaultRegistry({ enableDevProviders: false });
    expect(registry.list().map((d) => d.kind).sort()).toEqual(['ANTHROPIC', 'BEDROCK', 'FOUNDRY', 'OPENAI', 'SARVAM', 'VERTEX']);
    expect(registry.get('DEV_SCRIPTED')).toBeUndefined();
    expect(() => registry.require('DEV_SCRIPTED')).toThrow(expect.objectContaining({ code: 'provider_kind_not_available' }));
    expect(registry.list().every((d) => !d.devOnly)).toBe(true);
  });

  it('adds DEV_SCRIPTED only when dev providers are enabled', () => {
    const registry = createDefaultRegistry({ enableDevProviders: true });
    expect(registry.get('DEV_SCRIPTED')?.devOnly).toBe(true);
    expect(registry.has('DEV_SCRIPTED')).toBe(true);
    expect(registry.list()).toHaveLength(FIRST_PARTY_PROVIDERS.length);
  });

  it('kinds are open: any well-formed kind registers, dev-only gating comes from the definition', () => {
    const registry = createRegistry([...PRODUCTION_PROVIDERS, mistralLike, devScriptedProvider], { enableDevProviders: false });
    expect(registry.has('MISTRAL')).toBe(true);
    expect(registry.require('MISTRAL').label).toBe('Mistral AI');
    expect(registry.has('DEV_SCRIPTED')).toBe(false);
    expect(registry.get('NOT_REGISTERED')).toBeUndefined();
    for (const bad of ['mistral', 'M', 'MIS-TRAL', '9LIVES', `A${'B'.repeat(40)}`]) {
      expect(PROVIDER_KIND_PATTERN.test(bad)).toBe(false);
      expect(() => new ProviderRegistry().register({ ...mistralLike, kind: bad })).toThrow(expect.objectContaining({ code: 'provider_kind_invalid' }));
    }
  });

  it('every first-party definition carries its UI knowledge: mark, caching summary and per-model caching wording', () => {
    for (const d of FIRST_PARTY_PROVIDERS) {
      expect(d.kind).toMatch(PROVIDER_KIND_PATTERN);
      expect(d.mark).toMatch(/^[A-Z0-9]{1,4}$/);
      expect(d.cachingSummary.length).toBeGreaterThan(0);
    }
    const caching = (kind: string, model: string, settings: Record<string, unknown> = {}) => {
      const d = createDefaultRegistry({ enableDevProviders: true }).require(kind);
      return promptCachingOf(d, model, d.settingsSchema.parse(settings));
    };
    expect(caching('BEDROCK', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toMatchObject({ mode: 'explicit', mechanism: expect.stringContaining('cachePoint'), effect: { '1h': 'breakpoints · 1h TTL' } });
    expect(caching('BEDROCK', 'anthropic.claude-3-7-sonnet-20250219-v1:0').effect['1h']).toContain('Claude 4.5+');
    expect(caching('BEDROCK', 'meta.llama4-maverick-17b-instruct-v1:0')).toMatchObject({ mode: 'none', effect: { '5m': 'nothing sent' } });
    expect(caching('VERTEX', 'gemini-2.5-pro')).toMatchObject({ mode: 'implicit', mechanism: expect.stringContaining('implicit prefix') });
    expect(caching('VERTEX', 'claude-opus-5')).toMatchObject({ mode: 'explicit', mechanism: expect.stringContaining('cache_control') });
    expect(caching('OPENAI', 'gpt-5.5')).toMatchObject({ mode: 'key-based', mechanism: 'automatic + prompt cache key', effect: { '1h': 'cache key · 24h retention' } });
    expect(caching('OPENAI', 'gpt-5.6')).toMatchObject({ mode: 'key-based', mechanism: expect.stringContaining('GPT-5.6+'), effect: { '1h': 'cache key · 30m implicit retention' } });
    expect(caching('SARVAM', 'sarvam-105b')).toMatchObject({ mode: 'unverified', mechanism: expect.stringContaining('no documented control') });
    expect(caching('DEV_SCRIPTED', 'scripted-1')).toMatchObject({ mode: 'explicit', mechanism: expect.stringContaining('simulated') });
    const foundry = { resourceName: 'acme', deployments: { claude: { modelFamily: 'anthropic' }, llama: { modelFamily: 'other' } } };
    expect(caching('FOUNDRY', 'gpt-main', foundry).mode).toBe('key-based');
    expect(caching('FOUNDRY', 'claude', foundry).mechanism).toContain('cache_control');
    expect(caching('FOUNDRY', 'llama', foundry).mode).toBe('unverified');
    // Capability overrides change the wording too: caching turned off for one model.
    expect(caching('ANTHROPIC', 'claude-x', { capabilityOverrides: { 'claude-x': { promptCaching: 'UNSUPPORTED' } } }).mode).toBe('none');
    // A definition without its own wording gets the generic one from its capabilities.
    expect(promptCachingOf(mistralLike, 'm', {})).toMatchObject({ mode: 'unverified', mechanism: expect.stringContaining('no documented control') });
    const { describeCaching: _own, ...generic } = mistralLike;
    expect(promptCachingOf(generic, 'm', {})).toMatchObject({ mode: 'unverified', mechanism: 'unverified · no cache directives sent' });
  });

  it('Foundry names the underlying model of a deployment for catalog lookups', () => {
    const settings = foundryProvider.settingsSchema.parse({ resourceName: 'acme', deployments: { 'support-main': { modelFamily: 'openai', model: 'gpt-5.4-mini' } } });
    expect(foundryProvider.baseModel?.('support-main', settings)).toBe('gpt-5.4-mini');
    expect(foundryProvider.baseModel?.('gpt-5.5', settings)).toBeNull();
  });

  it('rejects duplicate registrations', () => {
    const registry = new ProviderRegistry().register(devScriptedProvider);
    expect(() => registry.register(devScriptedProvider)).toThrow(expect.objectContaining({ code: 'provider_already_registered' }));
  });

  it('creates adapters by configuration kind', async () => {
    const registry = createDefaultRegistry({ enableDevProviders: true });
    const adapter = registry.create(runtimeConfig('DEV_SCRIPTED', { latencyMs: 0 }, {}), { media });
    expect(adapter.kind).toBe('DEV_SCRIPTED');
    await expect(registry.checkHealth(runtimeConfig('DEV_SCRIPTED', { latencyMs: 0 }, {}), { media })).resolves.toMatchObject({
      status: 'OK',
    });
  });

  it('reports invalid configuration as UNCONFIGURED without echoing credential values', async () => {
    const registry = createDefaultRegistry({ enableDevProviders: false });
    const secret = 'AKIA-SHOULD-NOT-APPEAR';
    const health = await registry.checkHealth(runtimeConfig('BEDROCK', { authMode: 'ACCESS_KEYS' }, { accessKeyId: secret }), { media });
    expect(health.status).toBe('UNCONFIGURED');
    expect(JSON.stringify(health)).not.toContain(secret);
    const noModel = await registry.checkHealth(
      runtimeConfig('BEDROCK', { region: 'ap-south-1' }, { accessKeyId: 'a', secretAccessKey: 'b' }),
      { media },
    );
    expect(noModel).toMatchObject({ status: 'UNCONFIGURED', detail: 'No model configured for health checks' });
  });

  it('every production definition validates settings/credentials with zod and never leaks values in errors', () => {
    for (const definition of PRODUCTION_PROVIDERS) {
      const bad = runtimeConfig(definition.kind, { healthModel: 42 }, { apiKey: 'VALUE-THAT-MUST-NOT-LEAK' });
      try {
        definition.create(bad, { media });
        throw new Error(`${definition.kind} accepted invalid settings`);
      } catch (error) {
        expect(error).toMatchObject({ category: 'validation', code: 'provider_settings_invalid' });
        expect(JSON.stringify(error)).not.toContain('VALUE-THAT-MUST-NOT-LEAK');
      }
    }
  });

  it('applies per-model capability overrides from settings', () => {
    const caps = PRODUCTION_PROVIDERS.find((d) => d.kind === 'BEDROCK')?.capabilities('meta.llama4-maverick-17b-instruct-v1:0', {
      capabilityOverrides: { 'meta.llama4-maverick-17b-instruct-v1:0': { imageInput: true } },
    });
    expect(caps).toMatchObject({ imageInput: true, promptCaching: 'UNSUPPORTED' });
  });
});
