import type { ModelList, ModelOption } from '../../../lib/api/model-catalog';
import { decimalFromMicros } from '../models/money';

/**
 * Pure view logic for the profile dialog's model pickers (GET
 * /v1/model-providers/:id/models): search, the capability line and the price
 * line shown next to a model. Client-safe (type-only API imports).
 */

export const MAX_SHOWN = 60;

/** Search by id, display name or underlying model; exact and prefix matches first. */
export function filterModelOptions(models: readonly ModelOption[], query: string, limit = MAX_SHOWN): ModelOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return models.slice(0, limit);
  const rank = (m: ModelOption): number => {
    const id = m.id.toLowerCase();
    if (id === q) return 0;
    if (id.startsWith(q)) return 1;
    if (id.includes(q)) return 2;
    if (m.displayName?.toLowerCase().includes(q) || m.baseModel?.toLowerCase().includes(q)) return 3;
    return -1;
  };
  return models
    .map((m, i) => ({ m, i, r: rank(m) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.m);
}

/** 400000 → "400K", 1050000 → "1.05M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(2))}M`;
  if (n >= 1_000) return `${Number((n / 1_000).toFixed(1))}K`;
  return String(n);
}

const KIND_LABEL: Record<ModelOption['kind'], string | null> = { model: null, 'inference-profile': 'inference profile', deployment: 'deployment' };

/** "deployment of gpt-5.4-mini · 400K context · text, image in · tools · legacy". */
export function capabilityLine(m: ModelOption): string {
  const parts: string[] = [];
  const kind = KIND_LABEL[m.kind];
  if (kind) parts.push(m.baseModel ? `${kind} of ${m.baseModel}` : kind);
  if (m.contextWindow) parts.push(`${formatTokens(m.contextWindow)} context`);
  if (m.input?.length) parts.push(`${m.input.join(', ')} in`);
  if (m.toolCalling === true) parts.push('tools');
  if (m.toolCalling === false) parts.push('no tools');
  if (m.lifecycle === 'LEGACY') parts.push('legacy');
  if (m.lifecycle === 'DEPRECATED') parts.push('deprecated');
  return parts.join(' · ');
}

export interface PriceLine {
  /** configured = a model_pricing row costs it; offer = the catalog prices it but no row exists yet; none = unknown; dev = never priced. */
  kind: 'configured' | 'offer' | 'none' | 'dev';
  text: string;
}

const perMillion = (input: number, output: number, currency: string) => `in ${decimalFromMicros(input)} · out ${decimalFromMicros(output)} ${currency} / 1M`;

/**
 * The price shown next to a model: the row that will cost it, else the
 * catalog's offer, else "no catalog price". Models of a development-only
 * provider (`devOnly` on the model list) are never priced.
 */
export function priceLine(m: ModelOption | undefined, devOnly = false): PriceLine {
  if (devOnly) return { kind: 'dev', text: 'development model · never priced' };
  if (m?.configuredPrice) {
    const p = m.configuredPrice;
    const origin = p.origin === 'catalog' ? `catalog price${p.catalogSource ? ` (${p.catalogSource})` : ''}` : 'manual price';
    return { kind: 'configured', text: `${perMillion(p.inputPerMTokMicros, p.outputPerMTokMicros, p.currency)} · ${origin}` };
  }
  if (m?.catalogPrice) {
    const p = m.catalogPrice;
    const tier = p.tiers?.length ? ` · more above ${formatTokens(p.tiers[0]!.aboveInputTokens)} input` : '';
    return { kind: 'offer', text: `${perMillion(p.inputPerMTokMicros, p.outputPerMTokMicros, p.currency)}${tier} · ${p.source}, added when you save` };
  }
  return { kind: 'none', text: 'no catalog price — add one under Model pricing to see its cost' };
}

/** Compact line under an option in the open list. */
export function optionMeta(m: ModelOption, devOnly = false): string {
  const price = priceLine(m, devOnly);
  return [capabilityLine(m), price.kind === 'none' ? 'no catalog price' : price.text].filter(Boolean).join(' · ');
}

/** Status line under the picker for the loaded list. */
export function listSummary(list: ModelList, providerLabel: string): string {
  if (list.error) return `Could not list ${providerLabel} models: ${list.error.message}. You can still type a model id.`;
  const n = list.models.length;
  if (list.source === 'catalog') return `${providerLabel} has no model list endpoint; showing ${n} model${n === 1 ? '' : 's'} from the model catalog.`;
  const what = list.models.every((m) => m.kind === 'deployment') ? 'configured deployment' : 'model';
  return `${n} ${what}${n === 1 ? '' : 's'} from ${providerLabel}${list.cached ? ' (cached)' : ''} · type to search, or enter any id.`;
}
