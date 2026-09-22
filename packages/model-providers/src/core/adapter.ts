import type { ModelProviderAdapter, ModelRequest, ModelStreamEvent } from '../contract/types.js';
import { runGenerate } from './generate-call.js';
import { runHealthProbe } from './health.js';
import type { AiSdkAdapterSpec } from './spec.js';
import { runStream } from './stream-call.js';

/**
 * The one AI-SDK-backed ModelProviderAdapter. Provider modules supply only a
 * spec (model handle factory, provider-options builder, request-id headers,
 * usage fix-up); stream/generate/health/error handling are shared.
 */
export function createAiSdkAdapter(spec: AiSdkAdapterSpec): ModelProviderAdapter {
  const generate = (request: ModelRequest, model: string) => runGenerate(spec, request, model);
  return {
    kind: spec.kind,
    providerId: spec.providerId,
    capabilities: (model: string) => spec.capabilities(model),
    stream: (request: ModelRequest, model: string): AsyncIterable<ModelStreamEvent> => runStream(spec, request, model),
    generate,
    health: (model?: string) => runHealthProbe(model ?? spec.healthModel, generate, spec.healthProbe),
  };
}
