import { describe, expect, it } from 'vitest';
import { PROVIDER_KINDS } from '../src/contract/types.js';
import { devScriptedProvider } from '../src/providers/dev-scripted/definition.js';
import { createDefaultRegistry, PRODUCTION_PROVIDERS, ProviderRegistry } from '../src/registry.js';
import { media, runtimeConfig } from './support/requests.js';

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
    expect(registry.list()).toHaveLength(PROVIDER_KINDS.length);
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
