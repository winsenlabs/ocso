import { jsonResponse, sseResponse } from '../../support/fake-fetch.js';
import type { ToolEntry } from '../provider-contract.js';

/** OpenAI Responses API wire format (OpenAI API and Azure OpenAI / Foundry). */

export const OPENAI_TEXT = 'Let me check your balance.';
export const OPENAI_TOOL_CALL = { toolName: 'core__get_balance', input: { accountId: 'primary' } };

export interface ResponsesUsageOptions {
  cacheWriteTokens?: number;
}

export const responsesUsage = (o: ResponsesUsageOptions = {}) => ({
  input_tokens: 2350,
  input_tokens_details: { cached_tokens: 2000, ...(o.cacheWriteTokens !== undefined ? { cache_write_tokens: o.cacheWriteTokens } : {}) },
  output_tokens: 25,
  output_tokens_details: { reasoning_tokens: 5 },
  total_tokens: 2375,
});

/** Research table: input includes cached tokens; cache writes only on GPT-5.6+. */
export const OPENAI_EXPECTED_USAGE = {
  inputTokens: 2350,
  uncachedInputTokens: 350,
  cachedInputTokens: 2000,
  cacheWriteTokens: null,
  outputTokens: 25,
  reasoningTokens: 5,
};

export function responsesStream(headers: Record<string, string>, model = 'gpt-5.5', usage = responsesUsage()): Response {
  const args = ['{"accountId":', '"primary"}'];
  return sseResponse(
    [
      { event: 'response.created', data: { type: 'response.created', response: { id: 'resp_stream_1', created_at: 1760000000, model } } },
      {
        event: 'response.output_item.added',
        data: { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
      },
      ...['Let me ', 'check your ', 'balance.'].map((delta) => ({
        event: 'response.output_text.delta',
        data: { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta },
      })),
      {
        event: 'response.output_item.done',
        data: { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1' } },
      },
      {
        event: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          output_index: 1,
          item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'core__get_balance', arguments: '' },
        },
      },
      ...args.map((delta) => ({
        event: 'response.function_call_arguments.delta',
        data: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta },
      })),
      {
        event: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          output_index: 1,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'core__get_balance',
            arguments: args.join(''),
            status: 'completed',
          },
        },
      },
      { event: 'response.completed', data: { type: 'response.completed', response: { incomplete_details: null, usage } } },
    ],
    { headers, initialDelayMs: 30, chunkDelayMs: 2 },
  );
}

export function responsesJson(headers: Record<string, string>, model = 'gpt-5.5', usage = responsesUsage()): Response {
  return jsonResponse(
    {
      id: 'resp_generate_1',
      object: 'response',
      created_at: 1760000000,
      status: 'completed',
      model,
      output: [
        {
          type: 'message',
          id: 'msg_2',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: OPENAI_TEXT, annotations: [] }],
        },
        {
          type: 'function_call',
          id: 'fc_2',
          call_id: 'call_2',
          name: 'core__get_balance',
          arguments: '{"accountId":"primary"}',
          status: 'completed',
        },
      ],
      usage,
    },
    { headers },
  );
}

const CODES: Record<number, string> = {
  401: 'invalid_api_key',
  403: 'unsupported_country_region_territory',
  429: 'rate_limit_exceeded',
  500: 'server_error',
  503: 'service_unavailable',
};

export function openAiError(status: number, echo: string, headers: Record<string, string> = {}): Response {
  return jsonResponse(
    { error: { message: `Request rejected: ${echo}`, type: 'invalid_request_error', param: null, code: CODES[status] ?? null } },
    { status, headers: { 'x-request-id': 'req_err_1', ...headers } },
  );
}

type ResponsesTool = { name: string; parameters: unknown } & Record<string, unknown>;

export function responsesTools(body: unknown): ToolEntry[] {
  const tools = ((body as { tools?: ResponsesTool[] }).tools ?? []) as ResponsesTool[];
  return tools.map((t) => ({
    name: t.name,
    schema: t.parameters,
    // `type: 'function'` is the Responses tool envelope; `strict` is only sent when set.
    extraKeys: Object.keys(t).filter((k) => !['type', 'name', 'description', 'parameters'].includes(k)),
  }));
}
