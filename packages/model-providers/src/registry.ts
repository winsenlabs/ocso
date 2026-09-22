import { DomainError, ErrorCategory, isDomainError, validation } from '@ocso/domain';
import type {
  AdapterDeps,
  ModelProviderAdapter,
  ProviderHealth,
  ProviderKind,
  ProviderRuntimeConfig,
} from './contract/types.js';
import { anthropicProvider } from './providers/anthropic/definition.js';
import { bedrockProvider } from './providers/bedrock/definition.js';
import type { ProviderDefinition } from './providers/definition.js';
import { devScriptedProvider } from './providers/dev-scripted/definition.js';
import { foundryProvider } from './providers/foundry/definition.js';
import { openAiProvider } from './providers/openai/definition.js';
import { sarvamProvider } from './providers/sarvam/definition.js';
import { vertexProvider } from './providers/vertex/definition.js';

/**
 * Provider registry (ADR-006): provider modules register a definition; the
 * rest of OCSO looks them up by kind. No switch statement names providers.
 */
export class ProviderRegistry {
  private readonly definitions = new Map<ProviderKind, ProviderDefinition>();

  register<S, C>(definition: ProviderDefinition<S, C>): this {
    if (this.definitions.has(definition.kind)) {
      throw new DomainError(ErrorCategory.CONFLICT, 'provider_already_registered', `Provider ${definition.kind} is already registered`);
    }
    this.definitions.set(definition.kind, definition);
    return this;
  }

  get(kind: ProviderKind): ProviderDefinition | undefined {
    return this.definitions.get(kind);
  }

  require(kind: ProviderKind): ProviderDefinition {
    const definition = this.definitions.get(kind);
    if (!definition) throw validation('provider_kind_not_available', `Provider ${kind} is not available in this deployment`, { kind });
    return definition;
  }

  list(): ProviderDefinition[] {
    return [...this.definitions.values()];
  }

  create(config: ProviderRuntimeConfig, deps: AdapterDeps): ModelProviderAdapter {
    return this.require(config.kind).create(config, deps);
  }

  /** Health for a stored configuration. Never throws: bad configuration is UNCONFIGURED. */
  async checkHealth(config: ProviderRuntimeConfig, deps: AdapterDeps, model?: string): Promise<ProviderHealth> {
    let adapter: ModelProviderAdapter;
    try {
      adapter = this.create(config, deps);
    } catch (error) {
      const detail = isDomainError(error) ? `${error.code}: ${error.message}` : 'provider_configuration_invalid';
      return { status: 'UNCONFIGURED', latencyMs: null, checkedAt: new Date().toISOString(), detail };
    }
    return adapter.health(model);
  }
}

/** The six production providers (docs/06 §1). */
export const PRODUCTION_PROVIDERS: readonly ProviderDefinition[] = [
  bedrockProvider,
  vertexProvider,
  foundryProvider,
  openAiProvider,
  anthropicProvider,
  sarvamProvider,
];

export interface DefaultRegistryOptions {
  /** Register DEV_SCRIPTED (ADR-015: only when OCSO_ENABLE_DEV_PROVIDERS=true). */
  enableDevProviders: boolean;
}

export function createDefaultRegistry(options: DefaultRegistryOptions): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const definition of PRODUCTION_PROVIDERS) registry.register(definition);
  if (options.enableDevProviders) registry.register(devScriptedProvider);
  return registry;
}
