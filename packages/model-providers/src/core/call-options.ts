import { jsonSchema, Output, type JSONSchema7, type ModelMessage as SdkModelMessage, type streamText } from 'ai';
import type { ModelRequest } from '../contract/types.js';
import { buildSdkPrompt, type SdkPrompt } from './prompt.js';
import { assertRequestSupported } from './request-guard.js';
import type { AiSdkAdapterSpec, ProviderOptionsPlan } from './spec.js';
import { toSdkTools } from './tools.js';

type StreamTextOptions = Parameters<typeof streamText>[0];

/** Options shared by `streamText` and `generateText` (same shape in v7). */
export type SdkCallOptions = Omit<StreamTextOptions, 'prompt' | 'messages' | 'onError' | 'onChunk' | 'onEnd' | 'onStepEnd'> & {
  messages: SdkModelMessage[];
  prompt?: never;
};

export interface PreparedCall {
  options: SdkCallOptions;
  prompt: SdkPrompt;
  plan: ProviderOptionsPlan;
}

/**
 * Translate a neutral request into AI SDK call options. The invariants from
 * ADR-006 live here: model instance (never a string id), `toolOrder: []`,
 * tools always resent, `maxRetries: 0` (OCSO owns retry/fallback), total
 * timeout + caller abort signal, and telemetry off (OCSO emits its own spans;
 * SDK spans would record prompts).
 */
export async function prepareCall(spec: AiSdkAdapterSpec, request: ModelRequest, model: string): Promise<PreparedCall> {
  const caps = spec.capabilities(model);
  assertRequestSupported(request, caps, model);
  const plan = spec.providerOptions(model, request);
  const cacheOn = request.cache.policy !== 'OFF';
  const prompt = await buildSdkPrompt(
    request,
    { breakpoint: cacheOn ? plan.breakpoint : undefined, maxBreakpoints: plan.maxBreakpoints },
    spec.media,
  );
  const tools = toSdkTools(request.tools);

  const options: SdkCallOptions = {
    model: spec.languageModel(model, request),
    messages: prompt.messages,
    maxOutputTokens: request.maxOutputTokens,
    maxRetries: 0,
    timeout: { totalMs: request.timeoutMs },
    toolOrder: [],
    telemetry: { isEnabled: false },
  };
  if (prompt.instructions.length > 0) options.instructions = prompt.instructions;
  if (tools) {
    options.tools = tools;
    if (request.toolChoice) options.toolChoice = request.toolChoice;
  }
  if (request.temperature !== undefined) options.temperature = request.temperature;
  if (request.reasoning !== undefined && caps.reasoning && plan.portableReasoning !== false) {
    options.reasoning = request.reasoning;
  }
  if (request.abortSignal) options.abortSignal = request.abortSignal;
  if (plan.request && Object.keys(plan.request).length > 0) options.providerOptions = plan.request;
  if (request.responseSchema) {
    options.output = Output.object({ schema: jsonSchema<unknown>(request.responseSchema as JSONSchema7) });
  }
  return { options, prompt, plan };
}
