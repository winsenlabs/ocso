import { isDomainError } from '@ocso/domain';
import type {
  AdapterDeps,
  FinishReason,
  ModelCapabilities,
  ModelProviderAdapter,
  ModelRequest,
  NormalizedUsage,
  ProviderHealth,
  ProviderRegistry,
} from '@ocso/model-providers';
import type { SecretStore } from '@ocso/secrets';
import { resolveCredentials, toRuntimeConfig, type ProviderRow } from './provider-config.js';

/** "Test connection" (design/04): health probe plus one tiny real generation. */

export interface ProviderTestCall {
  ok: boolean;
  model: string;
  latencyMs: number | null;
  ttftMs: number | null;
  finishReason: FinishReason | null;
  /** First characters of the model's reply to "Reply with OK". */
  replyPreview: string | null;
  usage: NormalizedUsage | null;
  requestId: string | null;
  /** Normalized, value-free error (adapters never include bodies or credentials). */
  error: { category: string; code: string; message: string } | null;
}

export interface ProviderTestResult {
  providerId: string;
  status: 'OK' | 'DEGRADED' | 'DOWN' | 'UNCONFIGURED';
  /** Model probed; null when none was given, configured or used by a profile. */
  model: string | null;
  health: ProviderHealth;
  call: ProviderTestCall | null;
  capabilities: ModelCapabilities | null;
  checkedAt: string;
}

/**
 * Smallest output budget every provider accepts: the OpenAI Responses API
 * rejects `max_output_tokens` below 16, so a budget of 8 would fail there.
 */
export const TEST_CALL_MAX_OUTPUT_TOKENS = 16;

const testRequest = (): ModelRequest => ({
  purpose: 'TEST',
  system: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK' }] }],
  tools: [],
  maxOutputTokens: TEST_CALL_MAX_OUTPUT_TOKENS,
  timeoutMs: 20_000,
  cache: { policy: 'OFF' },
});

async function generateOnce(adapter: ModelProviderAdapter, model: string): Promise<ProviderTestCall> {
  try {
    const result = await adapter.generate(testRequest(), model);
    return {
      ok: true,
      model,
      latencyMs: result.latencyMs,
      ttftMs: result.ttftMs,
      finishReason: result.finishReason,
      replyPreview: result.text.slice(0, 80),
      usage: result.usage,
      requestId: result.identity.requestId,
      error: null,
    };
  } catch (error) {
    const e = isDomainError(error) ? error : null;
    return {
      ok: false,
      model,
      latencyMs: null,
      ttftMs: null,
      finishReason: null,
      replyPreview: null,
      usage: null,
      requestId: null,
      error: { category: e?.category ?? 'internal', code: e?.code ?? 'model_call_failed', message: e?.message ?? 'Model call failed' },
    };
  }
}

function overallStatus(health: ProviderHealth, call: ProviderTestCall | null): ProviderTestResult['status'] {
  if (health.status !== 'OK') return health.status;
  return call && !call.ok ? 'DEGRADED' : 'OK';
}

export async function runProviderTest(
  deps: { registry: ProviderRegistry; secrets: SecretStore; adapterDeps: AdapterDeps },
  row: ProviderRow,
  model: string | null,
): Promise<ProviderTestResult> {
  const checkedAt = new Date().toISOString();
  let adapter: ModelProviderAdapter;
  try {
    const credentials = await resolveCredentials(deps.secrets, row.secretRefs);
    adapter = deps.registry.create(toRuntimeConfig(row, credentials), deps.adapterDeps);
  } catch (error) {
    const detail = isDomainError(error) ? `${error.code}: ${error.message}` : 'provider_configuration_invalid';
    const health: ProviderHealth = { status: 'UNCONFIGURED', latencyMs: null, checkedAt, detail };
    return { providerId: row.id, status: 'UNCONFIGURED', model, health, call: null, capabilities: null, checkedAt };
  }
  const health = await adapter.health(model ?? undefined);
  const reachable = health.status === 'OK' || health.status === 'DEGRADED';
  const call = reachable && model ? await generateOnce(adapter, model) : null;
  return {
    providerId: row.id,
    status: overallStatus(health, call),
    model,
    health,
    call,
    capabilities: model ? adapter.capabilities(model) : null,
    checkedAt,
  };
}

/** Value-free error text to store on the provider row. */
export function testErrorText(result: ProviderTestResult): string | null {
  if (result.status === 'OK') return null;
  if (result.call?.error) return `${result.call.error.code}: ${result.call.error.message}`;
  return result.health.detail ?? result.status;
}
