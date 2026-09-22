import { createPublicKey, createVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { vertexProvider } from '../../src/providers/vertex/definition.js';
import { createServiceAccountTokenProvider, parseServiceAccountKey } from '../../src/providers/vertex/service-account.js';
import { fakeFetch, jsonResponse, sseResponse } from '../support/fake-fetch.js';
import { collect, media, runtimeConfig, standardRequest } from '../support/requests.js';
import {
  ANTHROPIC_EXPECTED_USAGE,
  ANTHROPIC_TEXT,
  ANTHROPIC_TOOL_CALL,
  anthropicError,
  anthropicMessage,
  anthropicPlacement,
  anthropicStream,
  anthropicTools,
} from './fixtures/anthropic-format.js';
import { ACCESS_TOKEN, googleTokenEndpoint, SA_PRIVATE_KEY, SA_PRIVATE_KEY_ID, SERVICE_ACCOUNT_JSON } from './fixtures/google-auth.js';
import { describeProviderContract, harness, type ContractFixture, type ToolEntry } from './provider-contract.js';

const TEXT = 'Let me check your balance.';
const usageMetadata = {
  promptTokenCount: 2350,
  cachedContentTokenCount: 2000,
  candidatesTokenCount: 20,
  thoughtsTokenCount: 5,
  totalTokenCount: 2375,
};

/** Research table: reads from cachedContentTokenCount; writes never reported; output = candidates + thoughts. */
const GEMINI_USAGE = {
  inputTokens: 2350,
  uncachedInputTokens: 350,
  cachedInputTokens: 2000,
  cacheWriteTokens: null,
  outputTokens: 25,
  reasoningTokens: 5,
};

const functionCall = { functionCall: { name: 'core__get_balance', args: { accountId: 'primary' } } };

function geminiStream(): Response {
  const chunk = (parts: unknown[], extra: Record<string, unknown> = {}) => ({
    data: { candidates: [{ content: { role: 'model', parts }, ...extra }], modelVersion: 'gemini-3.1-pro', responseId: 'vtx_resp_stream' },
  });
  return sseResponse(
    [
      chunk([{ text: 'Let me ' }]),
      chunk([{ text: 'check your ' }]),
      chunk([{ text: 'balance.' }]),
      { data: { ...chunk([functionCall], { finishReason: 'STOP' }).data, usageMetadata } },
    ],
    { initialDelayMs: 30, chunkDelayMs: 2 },
  );
}

function geminiJson(): Response {
  return jsonResponse({
    candidates: [{ content: { role: 'model', parts: [{ text: TEXT }, functionCall] }, finishReason: 'STOP' }],
    usageMetadata,
    modelVersion: 'gemini-3.1-pro',
    responseId: 'vtx_resp_generate',
  });
}

const STATUS: Record<number, string> = {
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
  503: 'UNAVAILABLE',
};

const geminiError = (status: number, echo: string) =>
  jsonResponse({ error: { code: status, message: `Request failed: ${echo}`, status: STATUS[status] ?? 'INVALID_ARGUMENT' } }, { status });

type FunctionDeclaration = { name: string; parameters?: unknown; parametersJsonSchema?: unknown } & Record<string, unknown>;

function geminiTools(body: unknown): ToolEntry[] {
  const decls = (body as { tools?: Array<{ functionDeclarations?: FunctionDeclaration[] }> }).tools?.[0]?.functionDeclarations ?? [];
  return decls.map((d) => ({
    name: d.name,
    schema: d.parametersJsonSchema ?? d.parameters,
    extraKeys: Object.keys(d).filter((k) => !['name', 'description', 'parameters', 'parametersJsonSchema'].includes(k)),
  }));
}

const config = runtimeConfig('VERTEX', { location: 'global' }, { serviceAccountJson: SERVICE_ACCOUNT_JSON });
const secrets = [SA_PRIVATE_KEY_ID, ACCESS_TOKEN, SA_PRIVATE_KEY.split('\n')[1] ?? SA_PRIVATE_KEY];

const gemini: ContractFixture = {
  name: 'Vertex AI Gemini',
  definition: vertexProvider,
  config,
  model: 'gemini-3.1-pro',
  secrets,
  auxiliary: googleTokenEndpoint,
  streamResponse: geminiStream,
  generateResponse: geminiJson,
  errorResponse: geminiError,
  tools: geminiTools,
  expected: {
    streamText: TEXT,
    toolCall: { toolName: 'core__get_balance', input: { accountId: 'primary' } },
    streamUsage: GEMINI_USAGE,
    generateUsage: GEMINI_USAGE,
    streamRequestId: 'vtx_resp_stream',
    generateRequestId: 'vtx_resp_generate',
    region: 'global',
    // Implicit caching only: nothing to send.
    prefixCacheDirectives: 0,
  },
  assertPrefixPlacement: (body) => {
    const b = body as { systemInstruction?: { parts: Array<{ text: string }> }; cachedContent?: unknown };
    expect(b.cachedContent).toBeUndefined();
    expect(b.systemInstruction?.parts.map((p) => p.text)).toHaveLength(3);
  },
};

const claude: ContractFixture = {
  name: 'Vertex AI Claude',
  definition: vertexProvider,
  config,
  model: 'claude-sonnet-4-6',
  secrets,
  auxiliary: googleTokenEndpoint,
  streamResponse: () => anthropicStream(),
  generateResponse: () => anthropicMessage(),
  errorResponse: anthropicError,
  tools: anthropicTools,
  expected: {
    streamText: ANTHROPIC_TEXT,
    toolCall: ANTHROPIC_TOOL_CALL,
    streamUsage: ANTHROPIC_EXPECTED_USAGE,
    generateUsage: ANTHROPIC_EXPECTED_USAGE,
    streamRequestId: 'msg_01stream',
    generateRequestId: 'msg_01generate',
    region: 'global',
    prefixCacheDirectives: 3,
  },
  assertPrefixPlacement: (body) => anthropicPlacement(body),
};

describeProviderContract(gemini);
describeProviderContract(claude);

describe('Vertex specifics', () => {
  it('routes Gemini and Claude to their endpoints with a service-account bearer token', async () => {
    const h = harness(gemini, (req) => (req.url.includes('anthropic') ? anthropicStream() : geminiStream()));
    await collect(h.adapter.stream(standardRequest(), 'gemini-3.1-pro'));
    await collect(h.adapter.stream(standardRequest(), 'claude-sonnet-4-6'));
    expect(h.modelCalls.map((c) => c.url)).toEqual([
      'https://aiplatform.googleapis.com/v1beta1/projects/ocso-test/locations/global/publishers/google/models/gemini-3.1-pro:streamGenerateContent?alt=sse',
      'https://aiplatform.googleapis.com/v1/projects/ocso-test/locations/global/publishers/anthropic/models/claude-sonnet-4-6:streamRawPredict',
    ]);
    for (const call of h.modelCalls) expect(call.headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect((h.modelCalls[1]?.body as { anthropic_version: string }).anthropic_version).toBe('vertex-2023-10-16');
    // One token exchange serves both calls (cached until shortly before expiry).
    expect(h.allCalls.filter((c) => c.url.includes('oauth2')).length).toBe(1);
  });

  it('signs a verifiable RS256 JWT-bearer assertion for the cloud-platform scope', async () => {
    const key = parseServiceAccountKey(SERVICE_ACCOUNT_JSON);
    const ff = fakeFetch((req) => googleTokenEndpoint(req) ?? jsonResponse({}, { status: 404 }));
    const token = createServiceAccountTokenProvider(key, ff.fetch, () => 1_760_000_000_000);
    await expect(token()).resolves.toBe(ACCESS_TOKEN);
    const assertion = new URLSearchParams(String(ff.calls[0]?.body)).get('assertion') ?? '';
    const [header, claims, signature] = assertion.split('.');
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT', kid: SA_PRIVATE_KEY_ID });
    expect(JSON.parse(Buffer.from(claims ?? '', 'base64url').toString())).toEqual({
      iss: 'ocso-runtime@ocso-test.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_760_000_000,
      exp: 1_760_003_600,
    });
    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${claims}`)
      .verify(createPublicKey(SA_PRIVATE_KEY), Buffer.from(signature ?? '', 'base64url'));
    expect(verified).toBe(true);
  });

  it('maps a rejected token exchange to authentication without leaking key material', async () => {
    const h = harness({ ...gemini, auxiliary: undefined }, () => jsonResponse({ error: 'invalid_grant', error_description: SA_PRIVATE_KEY_ID }, { status: 400 }));
    await expect(h.adapter.generate(standardRequest(), 'gemini-3.1-pro')).rejects.toSatisfy((e: unknown) => {
      const s = JSON.stringify(e) + String((e as Error).message);
      return (e as { category?: string }).category === 'authentication' && !s.includes(SA_PRIVATE_KEY_ID);
    });
  });

  it('ignores an ambient GOOGLE_VERTEX_API_KEY (no silent switch to express mode)', async () => {
    process.env['GOOGLE_VERTEX_API_KEY'] = 'ambient-express-key';
    try {
      const h = harness(gemini, () => geminiJson());
      await h.adapter.generate(standardRequest(), 'gemini-3.1-pro');
      expect(h.modelCalls[0]?.headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(h.modelCalls[0]?.headers['x-goog-api-key']).toBeUndefined();
    } finally {
      delete process.env['GOOGLE_VERTEX_API_KEY'];
    }
  });

  it('validates the service account JSON by field name only', () => {
    const bad = runtimeConfig('VERTEX', {}, { serviceAccountJson: JSON.stringify({ private_key: 'nope' }) });
    expect(() => vertexProvider.create(bad, { media })).toThrow(/incomplete/);
    try {
      vertexProvider.create(bad, { media });
    } catch (e) {
      expect(JSON.stringify(e)).not.toContain('nope');
    }
  });

  it('declares Gemini reads-only cache reporting and Claude explicit caching', () => {
    expect(vertexProvider.capabilities('gemini-3.1-pro', { authMode: 'SERVICE_ACCOUNT_KEY' })).toMatchObject({
      promptCaching: 'AUTOMATIC',
      reportsCacheWrites: false,
      audioInput: true,
    });
    expect(vertexProvider.capabilities('claude-sonnet-4-6', { authMode: 'SERVICE_ACCOUNT_KEY' })).toMatchObject({
      promptCaching: 'EXPLICIT',
      reportsCacheWrites: true,
    });
  });
});
