import type { ModelCapabilities, ModelProviderAdapter, ModelRequest, ModelResult, ModelStreamEvent } from '@ocso/model-providers';

/** Scripted model: each call pops the next step (text and/or tool calls). */
export interface ScriptStep {
  text?: string;
  toolCalls?: Array<{ toolName: string; input: unknown }>;
  delayMs?: number;
  error?: Error;
}

export class ScriptedAdapter implements ModelProviderAdapter {
  readonly kind = 'DEV_SCRIPTED' as const;
  requests: ModelRequest[] = [];
  constructor(readonly providerId: string, public script: ScriptStep[] = []) {}

  capabilities(): ModelCapabilities {
    return { imageInput: true, fileInput: true, audioInput: false, toolCalling: true, structuredOutput: true, reasoning: false, streaming: true, promptCaching: 'EXPLICIT', reportsCacheWrites: true };
  }

  async generate(request: ModelRequest): Promise<ModelResult> {
    this.requests.push(request);
    const step = this.script.shift() ?? { text: 'OK.' };
    if (step.delayMs) await new Promise((r, reject) => {
      const timer = setTimeout(r, step.delayMs);
      request.abortSignal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      });
    });
    if (step.error) throw step.error;
    return {
      text: step.text ?? '',
      toolCalls: (step.toolCalls ?? []).map((c, i) => ({ toolCallId: `call_${this.requests.length}_${i}`, toolName: c.toolName, input: c.input })),
      finishReason: step.toolCalls?.length ? 'tool-calls' : 'stop',
      usage: { inputTokens: 1200, uncachedInputTokens: 200, cachedInputTokens: 1000, cacheWriteTokens: 0, outputTokens: 40, reasoningTokens: null },
      identity: { providerId: this.providerId, kind: 'DEV_SCRIPTED', model: 'scripted', region: null, requestId: 'req' },
      latencyMs: 5,
      ttftMs: 2,
      warnings: [],
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const result = await this.generate(request);
    if (result.text) yield { type: 'text-delta', text: result.text };
    yield { type: 'finish', result };
  }

  async health() {
    return { status: 'OK' as const, latencyMs: 1, checkedAt: new Date().toISOString() };
  }
}
