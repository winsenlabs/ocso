import { generateText } from 'ai';
import type { ModelRequest, ModelResult, ToolCallRequest } from '../contract/types.js';
import { prepareCall } from './call-options.js';
import { normalizeProviderError } from './errors.js';
import { buildResult, formatWarnings, identityOf, mapFinishReason, requestIdOf, stepUsage, sumUsage } from './result.js';
import type { AiSdkAdapterSpec } from './spec.js';
import { errorContext } from './stream-call.js';

/**
 * Non-streaming call (provider's non-streaming endpoint, e.g. Bedrock
 * Converse). TTFT is not observable without streaming, so it is `null`.
 */
export async function runGenerate(spec: AiSdkAdapterSpec, request: ModelRequest, model: string): Promise<ModelResult> {
  const started = performance.now();
  try {
    const prepared = await prepareCall(spec, request, model);
    const result = await generateText(prepared.options);
    const finishReason = mapFinishReason(result.finishReason);
    const toolCalls: ToolCallRequest[] = result.toolCalls.map((c) => ({
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      input: c.input,
    }));
    const structured = request.responseSchema && finishReason !== 'tool-calls' ? result.output : undefined;
    const last = result.finalStep;
    return buildResult(
      {
        text: result.text,
        toolCalls,
        structured,
        finishReason,
        usage: sumUsage(result.steps.map((s) => stepUsage(spec, model, s.usage))),
        identity: identityOf(spec, model, requestIdOf({ id: last.response.id, headers: last.response.headers }, spec.requestIdHeaders)),
        latencyMs: performance.now() - started,
        ttftMs: null,
        warnings: formatWarnings(result.warnings),
      },
      request,
    );
  } catch (error) {
    throw normalizeProviderError(error, errorContext(spec, request, model));
  }
}
