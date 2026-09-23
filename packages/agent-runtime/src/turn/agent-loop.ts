import type { ModelContentPart, ModelMessage } from '@ocso/domain';
import type { ModelGateway, GatewayResult } from '../model/gateway.js';
import type { UsageContext } from '../model/usage-recorder.js';
import type { HandoffArgs } from '../tools/builtins.js';
import type { ToolRunContext, ToolRunner } from '../tools/runner.js';
import type { TurnContext } from '../context/context-builder.js';

export interface LoopCallbacks {
  /** Streamed text (realtime only; never persisted by itself). */
  onDelta(text: string): void;
  /** Text the model produced before calling tools — persisted and delivered as its own message. */
  emitInterim(text: string): Promise<void>;
  onStatus(status: 'THINKING' | 'CALLING_TOOL' | 'WRITING' | 'WAITING_CONFIRMATION'): void;
}

export interface LoopResult {
  finalText: string | null;
  steps: number;
  handoff: HandoffArgs | null;
  awaitingConfirmation: { reason: string } | null;
  toolFailures: number;
  last: GatewayResult | null;
  stepLimitReached: boolean;
}

export interface LoopParams {
  profileId: string;
  maxSteps: number;
  context: TurnContext;
  toolContext: ToolRunContext;
  usage: UsageContext;
  signal: AbortSignal;
}

/**
 * The model/tool loop (docs/04 §3 steps 8–10). OCSO owns every tool execution
 * between model steps; the loop ends on a terminal reply or the step limit.
 */
export async function runAgentLoop(gateway: ModelGateway, tools: ToolRunner, params: LoopParams, cb: LoopCallbacks): Promise<LoopResult> {
  const { compiled } = params.context;
  const messages: ModelMessage[] = [...compiled.messages];
  const result: LoopResult = { finalText: null, steps: 0, handoff: null, awaitingConfirmation: null, toolFailures: 0, last: null, stepLimitReached: false };

  for (let step = 1; step <= params.maxSteps; step++) {
    cb.onStatus('THINKING');
    const response = await gateway.run({
      profileId: params.profileId,
      purpose: 'TURN',
      system: compiled.system,
      messages,
      tools: compiled.tools,
      cacheKey: compiled.hashes.agentPrefixHash,
      required: { toolCalling: compiled.tools.length > 0 },
      abortSignal: params.signal,
      context: params.usage,
      onTextDelta: cb.onDelta,
    });
    result.steps = step;
    result.last = response;

    if (response.toolCalls.length === 0) {
      result.finalText = response.text.trim() || null;
      return result;
    }
    if (response.text.trim()) await cb.emitInterim(response.text.trim());

    const assistant: ModelContentPart[] = [];
    if (response.text.trim()) assistant.push({ type: 'text', text: response.text.trim() });
    for (const call of response.toolCalls) {
      assistant.push({ type: 'tool-call', toolCallId: call.toolCallId, toolName: call.toolName, input: call.input });
    }
    messages.push({ role: 'assistant', content: assistant });

    const toolResults: ModelContentPart[] = [];
    for (const call of response.toolCalls) {
      cb.onStatus('CALLING_TOOL');
      const outcome = await tools.run(call, params.toolContext);
      if (outcome.handoff) result.handoff ??= outcome.handoff;
      if (outcome.status === 'AWAITING_CONFIRMATION') {
        cb.onStatus('WAITING_CONFIRMATION');
        const reason = outcome.output.type === 'json' ? String((outcome.output.value as { reason?: unknown }).reason ?? 'confirmation required') : 'confirmation required';
        result.awaitingConfirmation ??= { reason };
      }
      if (outcome.status === 'FAILED' || outcome.status === 'DENIED') result.toolFailures++;
      toolResults.push({ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: outcome.output });
    }
    messages.push({ role: 'tool', content: toolResults });
  }
  result.stepLimitReached = true;
  return result;
}
