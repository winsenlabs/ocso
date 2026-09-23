import { jsonResponse, sseResponse } from '../../support/fake-fetch.js';
import type { ToolEntry } from '../provider-contract.js';

/** OpenAI Chat Completions wire format (Sarvam, Foundry non-OpenAI deployments). */

export const CHAT_TEXT = 'Let me check your balance.';
export const CHAT_TOOL_CALL = { toolName: 'core__get_balance', input: { accountId: 'primary' } };

export interface ChatUsageOptions {
  cachedTokens?: number;
}

export const chatUsage = (o: ChatUsageOptions = {}) => ({
  prompt_tokens: 120,
  completion_tokens: 25,
  total_tokens: 145,
  ...(o.cachedTokens !== undefined ? { prompt_tokens_details: { cached_tokens: o.cachedTokens } } : {}),
});

/** No cached_tokens / reasoning details sent → "not reported" (null), never 0. */
export const CHAT_EXPECTED_USAGE = {
  inputTokens: 120,
  uncachedInputTokens: 120,
  cachedInputTokens: null,
  cacheWriteTokens: null,
  outputTokens: 25,
  reasoningTokens: null,
};

export function chatStream(model: string, headers: Record<string, string> = {}, usage = chatUsage()): Response {
  const base = { id: 'chatcmpl-stream-1', object: 'chat.completion.chunk', created: 1760000000, model };
  const delta = (d: Record<string, unknown>, finish: string | null = null) => ({
    data: { ...base, choices: [{ index: 0, delta: d, finish_reason: finish }] },
  });
  return sseResponse(
    [
      delta({ role: 'assistant', content: 'Let me ' }),
      delta({ content: 'check your ' }),
      delta({ content: 'balance.' }),
      delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'core__get_balance', arguments: '' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"accountId":' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '"primary"}' } }] }),
      delta({}, 'tool_calls'),
      { data: { ...base, choices: [], usage } },
    ],
    { headers, initialDelayMs: 30, chunkDelayMs: 2, done: true },
  );
}

export function chatJson(model: string, headers: Record<string, string> = {}, usage = chatUsage()): Response {
  return jsonResponse(
    {
      id: 'chatcmpl-generate-1',
      object: 'chat.completion',
      created: 1760000000,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: CHAT_TEXT,
            tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'core__get_balance', arguments: '{"accountId":"primary"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage,
    },
    { headers },
  );
}

export function chatError(status: number, echo: string, headers: Record<string, string> = {}): Response {
  return jsonResponse({ error: { message: `Request failed: ${echo}`, type: 'error', code: String(status) } }, { status, headers });
}

type ChatTool = { type: string; function: { name: string; parameters: unknown } & Record<string, unknown> };

export function chatTools(body: unknown): ToolEntry[] {
  const tools = ((body as { tools?: ChatTool[] }).tools ?? []) as ChatTool[];
  return tools.map((t) => ({
    name: t.function.name,
    schema: t.function.parameters,
    extraKeys: Object.keys(t.function).filter((k) => !['name', 'description', 'parameters'].includes(k)),
  }));
}
