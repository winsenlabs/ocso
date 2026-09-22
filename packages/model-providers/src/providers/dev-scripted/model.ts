import {
  APICallError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4Content,
  type LanguageModelV4FunctionTool,
  type LanguageModelV4GenerateResult,
  type LanguageModelV4StreamPart,
  type LanguageModelV4StreamResult,
} from '@ai-sdk/provider';
import { scriptReply, type ScriptedTurn } from './script.js';
import type { PrefixCacheSimulator } from './usage.js';

/**
 * DEVELOPMENT ONLY (ADR-015). A deterministic LanguageModelV4 that runs
 * through the same AI-SDK core path as the real providers, so the Compose
 * demo and end-to-end tests exercise streaming, tool calls, usage and cache
 * telemetry without vendor credentials.
 */

export interface ScriptedModelOptions {
  latencyMs: number;
  chunkDelayMs: number;
  simulateError?: 'RATE_LIMITED' | 'UNAVAILABLE' | undefined;
}

export interface ScriptedRuntime {
  cache: PrefixCacheSimulator;
  nextId(): string;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function simulatedFailure(kind: ScriptedModelOptions['simulateError']): APICallError | null {
  if (!kind) return null;
  const statusCode = kind === 'RATE_LIMITED' ? 429 : 503;
  return new APICallError({
    message: `Simulated ${kind} (dev-scripted)`,
    url: 'dev-scripted://local',
    requestBodyValues: {},
    statusCode,
    isRetryable: true,
  });
}

const functionTools = (options: LanguageModelV4CallOptions): LanguageModelV4FunctionTool[] =>
  (options.tools ?? []).filter((t): t is LanguageModelV4FunctionTool => t.type === 'function');

const outputText = (turn: ScriptedTurn) => (turn.kind === 'text' ? turn.text : `${turn.preface}${JSON.stringify(turn.input)}`);

/** Split into word-sized chunks so streaming looks like streaming. */
const chunksOf = (text: string) => text.match(/\S+\s*/g) ?? [text];

export class ScriptedLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = 'v4' as const;
  readonly provider = 'ocso.dev-scripted';
  readonly supportedUrls = {};

  constructor(
    readonly modelId: string,
    private readonly options: ScriptedModelOptions,
    private readonly runtime: ScriptedRuntime,
  ) {}

  private turn(call: LanguageModelV4CallOptions) {
    const failure = simulatedFailure(this.options.simulateError);
    if (failure) throw failure;
    const turn = scriptReply(call.prompt, functionTools(call));
    const toolCallId = `call_${this.runtime.nextId()}`;
    return { turn, toolCallId, usage: this.runtime.cache.usage(call, outputText(turn)), id: this.runtime.nextId() };
  }

  async doGenerate(call: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    await sleep(this.options.latencyMs, call.abortSignal);
    const { turn, toolCallId, usage, id } = this.turn(call);
    const content: LanguageModelV4Content[] =
      turn.kind === 'text'
        ? [{ type: 'text', text: turn.text }]
        : [
            { type: 'text', text: turn.preface },
            { type: 'tool-call', toolCallId, toolName: turn.toolName, input: JSON.stringify(turn.input) },
          ];
    return {
      content,
      finishReason: turn.kind === 'text' ? { unified: 'stop', raw: 'stop' } : { unified: 'tool-calls', raw: 'tool_use' },
      usage,
      response: { id, modelId: this.modelId, timestamp: new Date() },
      warnings: [],
    };
  }

  async doStream(call: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    const { turn, toolCallId, usage, id } = this.turn(call);
    const { latencyMs, chunkDelayMs } = this.options;
    const modelId = this.modelId;
    const signal = call.abortSignal;
    async function* parts(): AsyncGenerator<LanguageModelV4StreamPart> {
      yield { type: 'stream-start', warnings: [] };
      yield { type: 'response-metadata', id, modelId, timestamp: new Date() };
      await sleep(latencyMs, signal);
      const text = turn.kind === 'text' ? turn.text : turn.preface;
      yield { type: 'text-start', id: 'text-0' };
      for (const [i, chunk] of chunksOf(text).entries()) {
        if (i > 0) await sleep(chunkDelayMs, signal);
        yield { type: 'text-delta', id: 'text-0', delta: chunk };
      }
      yield { type: 'text-end', id: 'text-0' };
      if (turn.kind === 'tool-call') {
        const input = JSON.stringify(turn.input);
        yield { type: 'tool-input-start', id: toolCallId, toolName: turn.toolName };
        yield { type: 'tool-input-delta', id: toolCallId, delta: input };
        yield { type: 'tool-input-end', id: toolCallId };
        yield { type: 'tool-call', toolCallId, toolName: turn.toolName, input };
      }
      yield {
        type: 'finish',
        finishReason: turn.kind === 'text' ? { unified: 'stop', raw: 'stop' } : { unified: 'tool-calls', raw: 'tool_use' },
        usage,
      };
    }
    const iterator = parts();
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await iterator.return(undefined);
      },
    });
    return { stream, response: { headers: { 'x-request-id': id } } };
  }
}
