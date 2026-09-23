import { ErrorCategory, isDomainError, type DomainError } from '@ocso/domain';
import type { ModelRequest, ModelResult, ProviderHealth } from '../contract/types.js';
import type { HealthProbeOptions } from './spec.js';

export const HEALTH_TIMEOUT_MS = 15_000;

/** Tiny request: no system prompt, no tools, caching off, smallest output budget. */
export function healthProbeRequest(probe: HealthProbeOptions = {}, timeoutMs = HEALTH_TIMEOUT_MS): ModelRequest {
  const request: ModelRequest = {
    purpose: 'TEST',
    system: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    tools: [],
    maxOutputTokens: probe.maxOutputTokens ?? 1,
    timeoutMs,
    cache: { policy: 'OFF' },
  };
  if (probe.reasoning) request.reasoning = probe.reasoning;
  return request;
}

const DEGRADED: ReadonlySet<string> = new Set([ErrorCategory.PROVIDER_RATE_LIMITED, ErrorCategory.CAPACITY]);

function healthFromError(error: DomainError, latencyMs: number): ProviderHealth {
  const checkedAt = new Date().toISOString();
  const status = DEGRADED.has(error.category) ? 'DEGRADED' : 'DOWN';
  return { status, latencyMs, checkedAt, detail: `${error.code}: ${error.message}` };
}

/**
 * Run a health probe through the adapter's normal generate path. Never
 * throws: every failure becomes a status with a safe, normalized detail.
 */
export async function runHealthProbe(
  model: string | null | undefined,
  generate: (request: ModelRequest, model: string) => Promise<ModelResult>,
  probe: HealthProbeOptions = {},
): Promise<ProviderHealth> {
  if (!model) {
    return {
      status: 'UNCONFIGURED',
      latencyMs: null,
      checkedAt: new Date().toISOString(),
      detail: 'No model configured for health checks',
    };
  }
  const started = performance.now();
  try {
    await generate(healthProbeRequest(probe), model);
    return { status: 'OK', latencyMs: Math.round(performance.now() - started), checkedAt: new Date().toISOString() };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - started);
    if (isDomainError(error)) return healthFromError(error, latencyMs);
    return { status: 'DOWN', latencyMs, checkedAt: new Date().toISOString(), detail: 'model_call_failed' };
  }
}
