import { describe, expect, it } from 'vitest';
import { bedrockAuthOptions } from '../../src/providers/bedrock/credentials.js';
import { bedrockProvider } from '../../src/providers/bedrock/definition.js';
import { bedrockCapabilities, bedrockSupportsLongCacheTtl } from '../../src/providers/bedrock/models.js';
import { bedrockEvent, bedrockException } from '../support/aws-event-stream.js';
import { jsonResponse, streamingResponse } from '../support/fake-fetch.js';
import { collect, countKeys, CACHE_DIRECTIVE_KEYS, media, runtimeConfig, standardRequest } from '../support/requests.js';
import { captureError, describeProviderContract, harness, type ContractFixture, type ToolEntry } from './provider-contract.js';

const ACCESS_KEY_ID = 'AKIAOCSOTEST00000001';
const SECRET_KEY = 'ocso/test/SECRET/abcdefghijklmnop';
const MODEL = 'apac.anthropic.claude-sonnet-4-5-20250929-v1:0';
const TEXT = 'Let me check your balance.';
const usage = { inputTokens: 50, outputTokens: 25, totalTokens: 2375, cacheReadInputTokens: 2000, cacheWriteInputTokens: 300 };

/** Research table: Bedrock inputTokens excludes cached tokens; normalized input = input + read + write. */
const EXPECTED_USAGE = {
  inputTokens: 2350,
  uncachedInputTokens: 50,
  cachedInputTokens: 2000,
  cacheWriteTokens: 300,
  outputTokens: 25,
  reasoningTokens: null,
};

function converseStream(): Response {
  const frames = [
    bedrockEvent('messageStart', { role: 'assistant' }),
    ...['Let me ', 'check your ', 'balance.'].map((text) =>
      bedrockEvent('contentBlockDelta', { contentBlockIndex: 0, delta: { text } }),
    ),
    bedrockEvent('contentBlockStop', { contentBlockIndex: 0 }),
    bedrockEvent('contentBlockStart', {
      contentBlockIndex: 1,
      start: { toolUse: { toolUseId: 'tooluse_01', name: 'core__get_balance' } },
    }),
    bedrockEvent('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '{"accountId":' } } }),
    bedrockEvent('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '"primary"}' } } }),
    bedrockEvent('contentBlockStop', { contentBlockIndex: 1 }),
    bedrockEvent('messageStop', { stopReason: 'tool_use' }),
    bedrockEvent('metadata', { usage, metrics: { latencyMs: 120 } }),
  ];
  return streamingResponse(frames, {
    contentType: 'application/vnd.amazon.eventstream',
    headers: { 'x-amzn-requestid': 'bedrock-req-stream-1' },
    initialDelayMs: 30,
    chunkDelayMs: 2,
  });
}

function converse(): Response {
  return jsonResponse(
    {
      output: {
        message: {
          role: 'assistant',
          content: [{ text: TEXT }, { toolUse: { toolUseId: 'tooluse_02', name: 'core__get_balance', input: { accountId: 'primary' } } }],
        },
      },
      stopReason: 'tool_use',
      usage,
      metrics: { latencyMs: 110 },
    },
    { headers: { 'x-amzn-requestid': 'bedrock-req-generate-1' } },
  );
}

const ERROR_TYPES: Record<number, string> = {
  401: 'UnrecognizedClientException',
  403: 'AccessDeniedException',
  429: 'ThrottlingException',
  500: 'InternalServerException',
  503: 'ServiceUnavailableException',
};

function bedrockError(status: number, echo: string): Response {
  return jsonResponse(
    { message: `Request failed for ${echo}` },
    { status, headers: { 'x-amzn-requestid': 'bedrock-req-err', 'x-amzn-errortype': `${ERROR_TYPES[status] ?? 'ValidationException'}:http://internal.amazon.com/coral/com.amazon.bedrock/` } },
  );
}

type ToolSpecEntry = { toolSpec: { name: string; inputSchema: { json: unknown } } & Record<string, unknown> };

function bedrockTools(body: unknown): ToolEntry[] {
  const tools = (body as { toolConfig?: { tools?: ToolSpecEntry[] } }).toolConfig?.tools ?? [];
  return tools.map(({ toolSpec }) => ({
    name: toolSpec.name,
    schema: toolSpec.inputSchema.json,
    extraKeys: Object.keys(toolSpec).filter((k) => !['name', 'description', 'inputSchema'].includes(k)),
  }));
}

function assertPlacement(body: unknown, ttl?: string) {
  const b = body as { system: Array<Record<string, unknown>>; messages: Array<{ content: Array<Record<string, unknown>> }> };
  const cp = ttl ? { cachePoint: { type: 'default', ttl } } : { cachePoint: { type: 'default' } };
  expect(b.system).toEqual([
    { text: 'You are an OCSO virtual agent.' },
    { text: 'You are Maya from Acme Bank.' },
    cp,
    { text: 'Customer: Priya (CIF 1234).' },
    cp,
  ]);
  expect(b.messages[1]?.content.at(-1)).toEqual(cp);
  expect(b.messages[2]?.content.some((p) => 'cachePoint' in p)).toBe(false);
}

const fixture: ContractFixture = {
  name: 'AWS Bedrock (Converse)',
  definition: bedrockProvider,
  config: runtimeConfig('BEDROCK', { region: 'ap-south-1' }, { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_KEY }),
  model: MODEL,
  secrets: [ACCESS_KEY_ID, SECRET_KEY],
  streamResponse: converseStream,
  generateResponse: converse,
  errorResponse: bedrockError,
  tools: bedrockTools,
  expected: {
    streamText: TEXT,
    toolCall: { toolName: 'core__get_balance', input: { accountId: 'primary' } },
    streamUsage: EXPECTED_USAGE,
    generateUsage: EXPECTED_USAGE,
    streamRequestId: 'bedrock-req-stream-1',
    generateRequestId: 'bedrock-req-generate-1',
    region: 'ap-south-1',
    prefixCacheDirectives: 3,
  },
  assertPrefixPlacement: (body) => assertPlacement(body),
};

describeProviderContract(fixture);

describe('Bedrock specifics', () => {
  it('uses ConverseStream / Converse URLs in the configured region, SigV4-signed', async () => {
    const h = harness(fixture, (req) => (req.url.endsWith('/converse-stream') ? converseStream() : converse()));
    await collect(h.adapter.stream(standardRequest(), MODEL));
    await h.adapter.generate(standardRequest(), MODEL);
    const encoded = encodeURIComponent(MODEL);
    expect(h.modelCalls.map((c) => c.url)).toEqual([
      `https://bedrock-runtime.ap-south-1.amazonaws.com/model/${encoded}/converse-stream`,
      `https://bedrock-runtime.ap-south-1.amazonaws.com/model/${encoded}/converse`,
    ]);
    expect(h.modelCalls[0]?.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAOCSOTEST00000001\/\d{8}\/ap-south-1\/bedrock\//);
    expect(JSON.stringify(h.modelCalls[0]?.headers)).not.toContain(SECRET_KEY);
  });

  it('applies the 1h TTL on Claude 4.5+ only', async () => {
    const h = harness(fixture, () => converseStream());
    await collect(h.adapter.stream(standardRequest({ cache: { policy: 'PREFIX', ttl: '1h' } }), MODEL));
    assertPlacement(h.modelCalls[0]?.body, '1h');
    expect(bedrockSupportsLongCacheTtl('anthropic.claude-sonnet-4-20250514-v1:0')).toBe(false);
    expect(bedrockSupportsLongCacheTtl('us.anthropic.claude-opus-4-6-v1')).toBe(true);
    expect(bedrockSupportsLongCacheTtl('anthropic.claude-3-7-sonnet-20250219-v1:0')).toBe(false);
    expect(bedrockSupportsLongCacheTtl('amazon.nova-pro-v1:0')).toBe(false);
  });

  it('sends no cachePoint for model families without Bedrock prompt caching, and reports cache reads as null', async () => {
    const llama = { ...fixture, model: 'meta.llama3-3-70b-instruct-v1:0' };
    const h = harness(llama, () =>
      jsonResponse({ output: { message: { role: 'assistant', content: [{ text: 'hi' }] } }, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }),
    );
    const result = await h.adapter.generate(standardRequest(), llama.model);
    expect(countKeys(h.modelCalls[0]?.body, CACHE_DIRECTIVE_KEYS)).toBe(0);
    expect(result.usage.cachedInputTokens).toBeNull();
    expect(result.usage.cacheWriteTokens).toBeNull();
    expect(bedrockCapabilities('amazon.nova-lite-v1:0').promptCaching).toBe('EXPLICIT');
  });

  it('maps an in-stream throttlingException to provider_rate_limited', async () => {
    const h = harness(fixture, () =>
      streamingResponse([bedrockEvent('messageStart', { role: 'assistant' }), bedrockException('throttlingException', `slow down ${SECRET_KEY}`)], {
        contentType: 'application/vnd.amazon.eventstream',
      }),
    );
    const error = await captureError(() => collect(h.adapter.stream(standardRequest(), MODEL)));
    expect(error.category).toBe('provider_rate_limited');
    expect(JSON.stringify(error)).not.toContain(SECRET_KEY);
  });

  it('builds auth from access keys, IAM role (lazy default chain) or a Bedrock API key', () => {
    expect(bedrockAuthOptions('ACCESS_KEYS', { accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 'c' })).toEqual({
      apiKey: '',
      accessKeyId: 'a',
      secretAccessKey: 'b',
      sessionToken: 'c',
    });
    const role = bedrockAuthOptions('IAM_ROLE', {});
    expect(typeof role.credentialProvider).toBe('function');
    expect(role.accessKeyId).toBeUndefined();
    expect(role.apiKey).toBe('');
    expect(bedrockAuthOptions('API_KEY', { apiKey: 'k' })).toEqual({ apiKey: 'k' });
    expect(() => bedrockAuthOptions('ACCESS_KEYS', { accessKeyId: 'a' })).toThrow(/secret access key/);
  });

  it('ignores an ambient AWS_BEARER_TOKEN_BEDROCK when access keys are configured', async () => {
    process.env['AWS_BEARER_TOKEN_BEDROCK'] = 'ambient-bearer-token';
    try {
      const h = harness(fixture, () => converse());
      await h.adapter.generate(standardRequest(), MODEL);
      expect(h.modelCalls[0]?.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 /);
    } finally {
      delete process.env['AWS_BEARER_TOKEN_BEDROCK'];
    }
  });

  it('rejects configurations without a region, with a safe validation error', () => {
    const config = runtimeConfig('BEDROCK', {}, { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_KEY });
    expect(() => bedrockProvider.create(config, { media })).toThrow(/region/);
  });
});
