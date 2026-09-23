import { DomainError, ErrorCategory } from '@ocso/domain';
import { streamText, type CallWarning, type FinishReason as SdkFinishReason, type TextStreamPart, type ToolSet } from 'ai';
import type { ModelRequest, ModelStreamEvent, NormalizedUsage, ToolCallRequest } from '../contract/types.js';
import { prepareCall } from './call-options.js';
import { normalizeProviderError, type ErrorContext } from './errors.js';
import {
  buildResult,
  formatWarnings,
  identityOf,
  mapFinishReason,
  requestIdOf,
  stepUsage,
  sumUsage,
  type ResponseFacts,
} from './result.js';
import type { AiSdkAdapterSpec } from './spec.js';

/** Mutable accumulator for one streamed call (one SDK step per call; no tool executes). */
interface StreamState {
  text: string;
  toolCalls: ToolCallRequest[];
  usages: NormalizedUsage[];
  warnings: CallWarning[];
  finishReason: SdkFinishReason | undefined;
  response: ResponseFacts | undefined;
  sdkTtftMs: number | undefined;
  measuredTtftMs: number | undefined;
  error: unknown;
  aborted: boolean;
}

export function errorContext(spec: AiSdkAdapterSpec, request: ModelRequest, model: string): ErrorContext {
  return {
    kind: spec.kind,
    providerId: spec.providerId,
    model,
    callerAborted: request.abortSignal?.aborted === true,
    requestIdHeaders: spec.requestIdHeaders,
    secrets: spec.secrets,
  };
}

/** Apply one SDK stream part to the state; returns the OCSO event to emit, if any. */
function applyPart(
  part: TextStreamPart<ToolSet>,
  state: StreamState,
  spec: AiSdkAdapterSpec,
  model: string,
  elapsed: () => number,
): ModelStreamEvent | null {
  switch (part.type) {
    case 'text-delta': {
      if (part.text.length === 0) return null;
      state.measuredTtftMs ??= elapsed();
      state.text += part.text;
      return { type: 'text-delta', text: part.text };
    }
    case 'tool-call': {
      state.measuredTtftMs ??= elapsed();
      const call: ToolCallRequest = { toolCallId: part.toolCallId, toolName: part.toolName, input: part.input };
      state.toolCalls.push(call);
      return { type: 'tool-call', call };
    }
    case 'start-step':
      state.warnings.push(...part.warnings);
      return null;
    case 'finish-step':
      state.usages.push(stepUsage(spec, model, part.usage));
      state.finishReason = part.finishReason;
      state.response = { id: part.response.id, headers: part.response.headers };
      state.sdkTtftMs ??= part.performance.timeToFirstOutputMs;
      return null;
    case 'error':
      state.error ??= part.error;
      return null;
    case 'abort':
      state.aborted = true;
      return null;
    default:
      return null;
  }
}

/**
 * Stream one model call as OCSO events. Text deltas and tool calls are
 * emitted in provider order; the final event is always `finish`. Failures are
 * thrown as normalized DomainErrors (never emitted as events).
 */
export async function* runStream(
  spec: AiSdkAdapterSpec,
  request: ModelRequest,
  model: string,
): AsyncGenerator<ModelStreamEvent> {
  const started = performance.now();
  const elapsed = () => performance.now() - started;
  const ctx = () => errorContext(spec, request, model);
  let prepared;
  try {
    prepared = await prepareCall(spec, request, model);
  } catch (error) {
    throw normalizeProviderError(error, ctx());
  }
  const state: StreamState = {
    text: '',
    toolCalls: [],
    usages: [],
    warnings: [],
    finishReason: undefined,
    response: undefined,
    sdkTtftMs: undefined,
    measuredTtftMs: undefined,
    error: undefined,
    aborted: false,
  };
  // If the consumer stops iterating early, abort the HTTP stream so the
  // provider stops generating (and billing) and the socket is released.
  const consumerGone = new AbortController();
  const abortSignal = request.abortSignal ? AbortSignal.any([request.abortSignal, consumerGone.signal]) : consumerGone.signal;
  // onError swallows the SDK's default console.error (it would log raw provider bodies).
  const result = streamText({ ...prepared.options, abortSignal, onError: () => undefined });
  let drained = false;
  try {
    for await (const part of result.stream) {
      const event = applyPart(part, state, spec, model, elapsed);
      if (event) yield event;
    }
    drained = true;
  } catch (error) {
    state.error ??= error;
    drained = true;
  } finally {
    if (!drained) consumerGone.abort(new DOMException('stream consumer stopped', 'AbortError'));
  }
  if (state.aborted && state.error === undefined) {
    const reason = request.abortSignal?.aborted ? request.abortSignal.reason : new DOMException('timeout', 'TimeoutError');
    throw normalizeProviderError(asAbortError(reason), ctx());
  }
  if (state.error !== undefined) throw normalizeProviderError(state.error, ctx());
  if (state.finishReason === undefined) {
    throw new DomainError(ErrorCategory.PROVIDER_UNAVAILABLE, 'provider_empty_response', 'The model provider returned no response', {
      providerKind: spec.kind,
      providerId: spec.providerId,
      model,
    });
  }

  let structured: unknown;
  if (request.responseSchema && state.finishReason !== 'tool-calls') {
    try {
      structured = await result.output;
    } catch (error) {
      throw normalizeProviderError(error, ctx());
    }
  }
  const finishResult = buildResult(
    {
      text: state.text,
      toolCalls: state.toolCalls,
      structured,
      finishReason: mapFinishReason(state.finishReason),
      usage: sumUsage(state.usages),
      identity: identityOf(spec, model, requestIdOf(state.response, spec.requestIdHeaders)),
      latencyMs: elapsed(),
      ttftMs: state.sdkTtftMs ?? state.measuredTtftMs ?? null,
      warnings: formatWarnings(state.warnings),
    },
    request,
  );
  yield { type: 'finish', result: finishResult };
}

/** Abort reasons may be any value; make sure the normalizer sees an abort-named error. */
function asAbortError(reason: unknown): unknown {
  const name = (reason as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError' ? reason : new DOMException('aborted', 'AbortError');
}
