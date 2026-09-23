import { z } from 'zod';
import type { ModelInputKind, ProviderModelInfo } from '../contract/types.js';
import { getJson, invalidListing, isoOrNull, MAX_LIST_PAGES, trimBase, type ListContext } from './http.js';

/**
 * Anthropic `GET /v1/models` (research/09 §2): cursor pagination
 * (`limit` ≤ 1000, `after_id`, `has_more`/`last_id`), newest first. Each
 * item carries `display_name`, `created_at`, `max_input_tokens`,
 * `max_tokens` and a documented `capabilities` object — `image_input` and
 * `pdf_input` are mapped to input kinds; nothing else is inferred.
 */

const Support = z.object({ supported: z.boolean() }).loose();
const Item = z
  .object({
    id: z.string().min(1),
    display_name: z.string().optional(),
    created_at: z.string().optional(),
    max_input_tokens: z.number().nullable().optional(),
    max_tokens: z.number().nullable().optional(),
    capabilities: z.object({ image_input: Support.optional(), pdf_input: Support.optional() }).loose().nullable().optional(),
  })
  .loose();
const Page = z.object({ data: z.array(Item), has_more: z.boolean().optional(), last_id: z.string().nullable().optional() }).loose();

export const ANTHROPIC_VERSION = '2023-06-01';

function inputOf(caps: z.infer<typeof Item>['capabilities']): ModelInputKind[] | undefined {
  if (!caps) return undefined;
  const input: ModelInputKind[] = ['text'];
  if (caps.image_input?.supported) input.push('image');
  if (caps.pdf_input?.supported) input.push('pdf');
  return input;
}

const positive = (n: number | null | undefined) => (typeof n === 'number' && n > 0 ? n : undefined);

export function toAnthropicModel(item: z.infer<typeof Item>): ProviderModelInfo {
  const input = inputOf(item.capabilities);
  const contextWindow = positive(item.max_input_tokens);
  const maxOutputTokens = positive(item.max_tokens);
  return {
    id: item.id,
    displayName: item.display_name ?? null,
    createdAt: isoOrNull(item.created_at),
    ownedBy: 'anthropic',
    kind: 'model',
    ...(input ? { input } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  };
}

export interface AnthropicListAuth {
  baseURL: string;
  headers: Record<string, string>;
}

export async function listAnthropicModels(ctx: ListContext, auth: AnthropicListAuth): Promise<ProviderModelInfo[]> {
  const base = trimBase(auth.baseURL);
  const models: ProviderModelInfo[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const query = new URLSearchParams({ limit: '1000', ...(after ? { after_id: after } : {}) });
    const raw = await getJson(ctx, `${base}/models?${query}`, { 'anthropic-version': ANTHROPIC_VERSION, ...auth.headers });
    const parsed = Page.safeParse(raw);
    if (!parsed.success) throw invalidListing(ctx);
    models.push(...parsed.data.data.map(toAnthropicModel));
    if (!parsed.data.has_more || !parsed.data.last_id) break;
    after = parsed.data.last_id;
  }
  return models;
}
