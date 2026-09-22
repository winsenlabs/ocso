import { jsonResponse, sseResponse } from '../../support/fake-fetch.js';
import type { ToolEntry } from '../provider-contract.js';

/**
 * Anthropic Messages API wire format, shared by Anthropic 1P, Vertex-Claude
 * (rawPredict/streamRawPredict) and Claude on Foundry.
 */

export const ANTHROPIC_TEXT = 'Let me check your balance.';
export const ANTHROPIC_TOOL_CALL = { toolName: 'core__get_balance', input: { accountId: 'primary' } };

const usage = { input_tokens: 50, cache_creation_input_tokens: 300, cache_read_input_tokens: 2000 };

/** Research table: input = input + creation + read; reads/writes reported separately. */
export const ANTHROPIC_EXPECTED_USAGE = {
  inputTokens: 2350,
  uncachedInputTokens: 50,
  cachedInputTokens: 2000,
  cacheWriteTokens: 300,
  outputTokens: 25,
  reasoningTokens: null,
};

export function anthropicStream(headers: Record<string, string> = {}): Response {
  const text = ['Let me ', 'check your ', 'balance.'];
  return sseResponse(
    [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: 'msg_01stream',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { ...usage, output_tokens: 1 },
          },
        },
      },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      ...text.map((t) => ({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } },
      })),
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_01', name: 'core__get_balance', input: {} },
        },
      },
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"accountId":' } },
      },
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"primary"}' } },
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
      {
        event: 'message_delta',
        data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 25 } },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ],
    { headers, initialDelayMs: 30, chunkDelayMs: 2 },
  );
}

export function anthropicMessage(headers: Record<string, string> = {}): Response {
  return jsonResponse(
    {
      id: 'msg_01generate',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [
        { type: 'text', text: ANTHROPIC_TEXT },
        { type: 'tool_use', id: 'toolu_02', name: 'core__get_balance', input: { accountId: 'primary' } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { ...usage, output_tokens: 25 },
    },
    { headers },
  );
}

const ERROR_TYPES: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  429: 'rate_limit_error',
  500: 'api_error',
  503: 'overloaded_error',
};

export function anthropicError(status: number, echo: string): Response {
  return jsonResponse(
    { type: 'error', error: { type: ERROR_TYPES[status] ?? 'api_error', message: `Upstream said: ${echo}` } },
    { status, headers: { 'request-id': 'req_err_1' } },
  );
}

type AnthropicTool = { name: string; description?: string; input_schema: unknown } & Record<string, unknown>;

export function anthropicTools(body: unknown): ToolEntry[] {
  const tools = ((body as { tools?: AnthropicTool[] }).tools ?? []) as AnthropicTool[];
  return tools.map((t) => ({
    name: t.name,
    schema: t.input_schema,
    extraKeys: Object.keys(t).filter((k) => !['name', 'description', 'input_schema'].includes(k)),
  }));
}

/** cache_control on the AGENT_PREFIX + CONVERSATION_CONTEXT system blocks and the HISTORY message's last block. */
export function anthropicPlacement(body: unknown, expectTtl?: string): void {
  const b = body as {
    system: Array<{ text: string; cache_control?: unknown }>;
    messages: Array<{ role: string; content: Array<{ cache_control?: unknown }> }>;
  };
  const cc = expectTtl ? { type: 'ephemeral', ttl: expectTtl } : { type: 'ephemeral' };
  const marks = b.system.map((s) => s.cache_control);
  if (JSON.stringify(marks) !== JSON.stringify([undefined, cc, cc])) {
    throw new Error(`unexpected system cache_control placement: ${JSON.stringify(marks)}`);
  }
  const history = b.messages[1]?.content.at(-1)?.cache_control;
  if (JSON.stringify(history) !== JSON.stringify(cc)) throw new Error('HISTORY breakpoint missing on assistant message');
  if (b.messages[2]?.content.some((p) => p.cache_control)) throw new Error('current turn must not be marked');
}
