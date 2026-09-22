import type { CallWarning, FinishReason as SdkFinishReason, LanguageModelUsage } from 'ai';
import type {
  FinishReason,
  ModelIdentity,
  ModelRequest,
  ModelResult,
  NormalizedUsage,
  ToolCallRequest,
} from '../contract/types.js';
import { requestIdFromHeaders } from './errors.js';
import type { AiSdkAdapterSpec } from './spec.js';
import { addUsage, normalizeUsage, ZERO_USAGE } from './usage.js';

/** The SDK generates `aitxt-…` ids when a provider sends none; those are not provider ids. */
const SDK_GENERATED_ID = /^ai[a-z]*-/;

export interface ResponseFacts {
  id?: string | undefined;
  headers?: Record<string, string> | undefined;
}

export function requestIdOf(response: ResponseFacts | undefined, headerNames: readonly string[]): string | null {
  const fromHeader = requestIdFromHeaders(response?.headers, headerNames);
  if (fromHeader) return fromHeader;
  const id = response?.id;
  return id && !SDK_GENERATED_ID.test(id) ? id : null;
}

export function formatWarnings(warnings: readonly CallWarning[] | undefined): string[] {
  return (warnings ?? []).map((w) => {
    if (w.type === 'unsupported' || w.type === 'compatibility') {
      return `${w.type}: ${w.feature}${w.details ? ` (${w.details})` : ''}`;
    }
    return `${w.type}: ${'message' in w ? w.message : ''}`;
  });
}

const FINISH_REASONS: ReadonlySet<FinishReason> = new Set(['stop', 'length', 'tool-calls', 'content-filter', 'error', 'other']);

export function mapFinishReason(reason: SdkFinishReason | undefined): FinishReason {
  return reason && FINISH_REASONS.has(reason) ? reason : 'other';
}

/** Normalize one step's usage with the provider's reporting profile. */
export function stepUsage(spec: AiSdkAdapterSpec, model: string, usage: LanguageModelUsage): NormalizedUsage {
  const caps = spec.capabilities(model);
  const adjusted = spec.adjustUsage ? spec.adjustUsage(usage, model) : usage;
  return normalizeUsage(adjusted, {
    reportsCacheReads: caps.promptCaching === 'EXPLICIT' || caps.promptCaching === 'AUTOMATIC',
    reportsCacheWrites: caps.reportsCacheWrites,
  });
}

export function sumUsage(steps: readonly NormalizedUsage[]): NormalizedUsage {
  const [first, ...rest] = steps;
  return first ? rest.reduce(addUsage, first) : ZERO_USAGE;
}

export function identityOf(spec: AiSdkAdapterSpec, model: string, requestId: string | null): ModelIdentity {
  return { providerId: spec.providerId, kind: spec.kind, model, region: spec.region, requestId };
}

export interface ResultParts {
  text: string;
  toolCalls: ToolCallRequest[];
  structured?: unknown;
  finishReason: FinishReason;
  usage: NormalizedUsage;
  identity: ModelIdentity;
  latencyMs: number;
  ttftMs: number | null;
  warnings: string[];
}

export function buildResult(parts: ResultParts, request: ModelRequest): ModelResult {
  const result: ModelResult = {
    text: parts.text,
    toolCalls: parts.toolCalls,
    finishReason: parts.finishReason,
    usage: parts.usage,
    identity: parts.identity,
    latencyMs: Math.max(0, Math.round(parts.latencyMs)),
    ttftMs: parts.ttftMs === null ? null : Math.max(0, Math.round(parts.ttftMs)),
    warnings: parts.warnings,
  };
  if (request.responseSchema && parts.structured !== undefined) result.structured = parts.structured;
  return result;
}
