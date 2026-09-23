import { isDomainError, type DomainError } from '@ocso/domain';
import { describe, expect, it } from 'vitest';
import type { ModelRequest, NormalizedUsage, ProviderRuntimeConfig } from '../../src/contract/types.js';
import type { ProviderDefinition } from '../../src/providers/definition.js';
import { fakeFetch, never, type CapturedRequest } from '../support/fake-fetch.js';
import {
  CACHE_DIRECTIVE_KEYS,
  collect,
  countKeys,
  media,
  SORTED_TOOL_NAMES,
  standardRequest,
  TOOLS,
} from '../support/requests.js';

/**
 * Shared provider contract (ADR-006). Every provider runs the same suite
 * against recorded provider-format responses through a fake `fetch`.
 */

export interface ToolEntry {
  name: string;
  schema: unknown;
  /** Keys on the tool entry beyond name/description/schema (must be empty: schema-only). */
  extraKeys: string[];
}

export interface ContractFixture {
  name: string;
  definition: ProviderDefinition;
  config: ProviderRuntimeConfig;
  model: string;
  /** Credential values that must never appear in errors; error fixtures echo them. */
  secrets: string[];
  /** Answers non-model calls (OAuth token endpoints); undefined means "model call". */
  auxiliary?: ((req: CapturedRequest) => Response | undefined) | undefined;
  streamResponse(): Response;
  generateResponse(): Response;
  /** Provider-format error body for `status`, echoing the secrets like a careless upstream would. */
  errorResponse(status: number, echo: string): Response;
  tools(body: unknown): ToolEntry[];
  expected: {
    streamText: string;
    toolCall: { toolName: string; input: unknown };
    streamUsage: NormalizedUsage;
    generateUsage: NormalizedUsage;
    streamRequestId: string;
    generateRequestId: string;
    region: string | null;
    /** Cache directives (see CACHE_DIRECTIVE_KEYS) in the body for the standard PREFIX request. */
    prefixCacheDirectives: number;
  };
  /** Provider-specific checks of where the PREFIX directives landed. */
  assertPrefixPlacement?: ((body: unknown) => void) | undefined;
}

type Handler = (req: CapturedRequest) => Response | Promise<Response>;

export function harness(fx: ContractFixture, handler: Handler) {
  const modelCalls: CapturedRequest[] = [];
  const ff = fakeFetch((req) => {
    const aux = fx.auxiliary?.(req);
    if (aux) return aux;
    modelCalls.push(req);
    return handler(req);
  });
  const adapter = fx.definition.create(fx.config, { media, fetch: ff.fetch });
  return { adapter, modelCalls, allCalls: ff.calls };
}

export async function captureError(run: () => Promise<unknown>): Promise<DomainError> {
  try {
    await run();
  } catch (error) {
    if (!isDomainError(error)) throw new Error(`expected DomainError, got ${String(error)}`);
    return error;
  }
  throw new Error('expected the call to fail');
}

function assertNoSecrets(error: DomainError, secrets: readonly string[]) {
  const surfaces = [error.message, String(error), error.stack ?? '', JSON.stringify(error), JSON.stringify(error.details ?? {})];
  for (const secret of secrets) {
    for (const surface of surfaces) expect(surface).not.toContain(secret);
  }
  expect((error as { cause?: unknown }).cause).toBeUndefined();
}

export function describeProviderContract(fx: ContractFixture): void {
  const stream = (req: ModelRequest, handler: Handler) => {
    const h = harness(fx, handler);
    return { ...h, run: () => collect(h.adapter.stream(req, fx.model)) };
  };

  describe(`${fx.name} provider contract`, () => {
    it('(a) places provider cache directives when cache.policy is PREFIX', async () => {
      const s = stream(standardRequest(), () => fx.streamResponse());
      await s.run();
      const body = s.modelCalls[0]?.body;
      expect(countKeys(body, CACHE_DIRECTIVE_KEYS)).toBe(fx.expected.prefixCacheDirectives);
      fx.assertPrefixPlacement?.(body);
    });

    it('(a) sends no cache directives when cache.policy is OFF', async () => {
      const s = stream(standardRequest({ cache: { policy: 'OFF', key: 'agent-7:pv-3', ttl: '1h' } }), () => fx.streamResponse());
      await s.run();
      expect(countKeys(s.modelCalls[0]?.body, CACHE_DIRECTIVE_KEYS)).toBe(0);
    });

    it('(b) sends tool definitions sorted by name and schema-only', async () => {
      const s = stream(standardRequest(), () => fx.streamResponse());
      await s.run();
      const entries = fx.tools(s.modelCalls[0]?.body);
      expect(entries.map((t) => t.name)).toEqual(SORTED_TOOL_NAMES);
      for (const entry of entries) {
        expect(entry.extraKeys).toEqual([]);
        expect(entry.schema).toEqual(TOOLS.find((t) => t.name === entry.name)?.inputSchema);
      }
    });

    it('(c)(d) streams text deltas, then the tool call, then finish with normalized usage', async () => {
      const s = stream(standardRequest(), () => fx.streamResponse());
      const events = await s.run();
      const types = events.map((e) => e.type);
      expect(types.at(-1)).toBe('finish');
      expect(types.filter((t) => t === 'finish')).toHaveLength(1);
      const firstTool = types.indexOf('tool-call');
      expect(types.lastIndexOf('text-delta')).toBeLessThan(firstTool);
      expect(types.filter((t) => t === 'text-delta').length).toBeGreaterThan(1);
      const text = events.flatMap((e) => (e.type === 'text-delta' ? [e.text] : [])).join('');
      expect(text).toBe(fx.expected.streamText);
      const call = events.find((e) => e.type === 'tool-call');
      expect(call?.type === 'tool-call' && call.call).toMatchObject(fx.expected.toolCall);

      const finish = events.at(-1);
      if (finish?.type !== 'finish') throw new Error('no finish');
      expect(finish.result.finishReason).toBe('tool-calls');
      expect(finish.result.text).toBe(fx.expected.streamText);
      expect(finish.result.toolCalls).toHaveLength(1);
      expect(finish.result.toolCalls[0]).toMatchObject(fx.expected.toolCall);
      expect(finish.result.usage).toEqual(fx.expected.streamUsage);
      expect(finish.result.identity).toEqual({
        providerId: fx.config.id,
        kind: fx.config.kind,
        model: fx.model,
        region: fx.expected.region,
        requestId: fx.expected.streamRequestId,
      });
    });

    it('(e) records TTFT and total latency on streams', async () => {
      const s = stream(standardRequest(), () => fx.streamResponse());
      const events = await s.run();
      const finish = events.at(-1);
      if (finish?.type !== 'finish') throw new Error('no finish');
      expect(finish.result.ttftMs).not.toBeNull();
      // Fixtures delay the first byte by 30 ms.
      expect(finish.result.ttftMs).toBeGreaterThanOrEqual(20);
      expect(finish.result.latencyMs).toBeGreaterThanOrEqual(finish.result.ttftMs ?? 0);
    });

    it('(c) generate() maps text, tool calls, usage and request id (TTFT unavailable)', async () => {
      const h = harness(fx, () => fx.generateResponse());
      const result = await h.adapter.generate(standardRequest(), fx.model);
      expect(result.text).toBe(fx.expected.streamText);
      expect(result.toolCalls[0]).toMatchObject(fx.expected.toolCall);
      expect(result.finishReason).toBe('tool-calls');
      expect(result.usage).toEqual(fx.expected.generateUsage);
      expect(result.identity.requestId).toBe(fx.expected.generateRequestId);
      expect(result.ttftMs).toBeNull();
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it.each([
      [429, 'provider_rate_limited'],
      [500, 'provider_unavailable'],
      [503, 'provider_unavailable'],
    ])('(f) maps HTTP %i to %s on stream and generate, safely', async (status, category) => {
      const echo = fx.secrets.join(' ');
      const s = stream(standardRequest(), () => fx.errorResponse(status, echo));
      const streamError = await captureError(() => s.run());
      expect(streamError.category).toBe(category);
      expect(streamError.details?.['statusCode']).toBe(status);
      expect(streamError.message).not.toMatch(/overloaded|Internal server|Too many|quota/i);
      assertNoSecrets(streamError, fx.secrets);

      const h = harness(fx, () => fx.errorResponse(status, echo));
      const generateError = await captureError(() => h.adapter.generate(standardRequest(), fx.model));
      expect(generateError.category).toBe(category);
      assertNoSecrets(generateError, fx.secrets);
    });

    it('(f) maps a request that exceeds timeoutMs to timeout', async () => {
      const s = stream(standardRequest({ timeoutMs: 50 }), () => never());
      const error = await captureError(() => s.run());
      expect(error.category).toBe('timeout');
      expect(error.code).toBe('model_timeout');

      const h = harness(fx, () => never());
      const genError = await captureError(() => h.adapter.generate(standardRequest({ timeoutMs: 50 }), fx.model));
      expect(genError.category).toBe('timeout');
    });

    it('(f) maps caller cancellation to timeout/model_request_cancelled', async () => {
      const controller = new AbortController();
      const s = stream(standardRequest({ abortSignal: controller.signal }), () => never());
      setTimeout(() => controller.abort(), 20);
      const error = await captureError(() => s.run());
      expect(error.category).toBe('timeout');
      expect(error.code).toBe('model_request_cancelled');
    });

    it('(g) never puts credentials in thrown errors (401 echoing the key)', async () => {
      const echo = `invalid credentials: ${fx.secrets.join(' ')}`;
      const s = stream(standardRequest(), () => fx.errorResponse(401, echo));
      const error = await captureError(() => s.run());
      expect(error.category).toBe('authentication');
      assertNoSecrets(error, fx.secrets);

      const h = harness(fx, () => fx.errorResponse(403, echo));
      const denied = await captureError(() => h.adapter.generate(standardRequest(), fx.model));
      expect(denied.category).toBe('authorization');
      assertNoSecrets(denied, fx.secrets);
    });

    it('health() reports OK through a tiny generate and never throws', async () => {
      const ok = harness(fx, () => fx.generateResponse());
      await expect(ok.adapter.health(fx.model)).resolves.toMatchObject({ status: 'OK' });
      const probe = ok.modelCalls[0]?.body;
      expect(countKeys(probe, CACHE_DIRECTIVE_KEYS)).toBe(0);

      const limited = harness(fx, () => fx.errorResponse(429, 'x'));
      await expect(limited.adapter.health(fx.model)).resolves.toMatchObject({ status: 'DEGRADED' });
      const down = harness(fx, () => fx.errorResponse(401, fx.secrets.join(' ')));
      const health = await down.adapter.health(fx.model);
      expect(health.status).toBe('DOWN');
      for (const secret of fx.secrets) expect(JSON.stringify(health)).not.toContain(secret);
    });
  });
}
