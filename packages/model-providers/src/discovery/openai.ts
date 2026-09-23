import { z } from 'zod';
import type { ProviderModelInfo } from '../contract/types.js';
import { getJson, invalidListing, isoOrNull, trimBase, type ListContext } from './http.js';

/**
 * OpenAI `GET /v1/models` (research/09 §1): `{ object: 'list', data: [{ id,
 * object, created, owned_by }] }`, no pagination, no prices, no
 * capabilities. The listing mixes every model family the key can use, so
 * OCSO keeps only models the Responses API can drive as a chat model.
 */

const Listing = z.object({
  data: z.array(z.object({ id: z.string().min(1), created: z.number().optional(), owned_by: z.string().optional() }).loose()),
});

/**
 * Documented filter rule: an id is NOT a chat model when it contains any of
 * these markers — embeddings, speech/audio/realtime, image or video
 * generation, moderation, legacy completions (davinci/babbage, *-instruct),
 * search-preview and computer-use tool models. Everything else (gpt-*, o*,
 * chatgpt-*, codex, ft:… fine-tunes) is listed.
 */
export const OPENAI_NON_CHAT =
  /(embedding|whisper|transcribe|tts|audio|realtime|dall-e|gpt-image|chatgpt-image|image|sora|moderation|^davinci|^babbage|-instruct|search-preview|computer-use)/i;

export const isOpenAiChatModel = (id: string) => !OPENAI_NON_CHAT.test(id);

export interface OpenAiListSettings {
  baseURL?: string | undefined;
  organization?: string | undefined;
  project?: string | undefined;
}

export function openAiHeaders(apiKey: string, settings: OpenAiListSettings): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    ...(settings.organization ? { 'openai-organization': settings.organization } : {}),
    ...(settings.project ? { 'openai-project': settings.project } : {}),
  };
}

/** Parse an OpenAI-compatible `/models` payload (also used for Sarvam). */
export function parseOpenAiListing(ctx: Pick<ListContext, 'kind' | 'providerId'>, raw: unknown, keep: (id: string) => boolean): ProviderModelInfo[] {
  const parsed = Listing.safeParse(raw);
  if (!parsed.success) throw invalidListing(ctx);
  return parsed.data.data
    .filter((m) => keep(m.id))
    .map((m) => ({
      id: m.id,
      displayName: null,
      createdAt: isoOrNull(m.created),
      ownedBy: m.owned_by ?? null,
      kind: 'model' as const,
    }));
}

export async function listOpenAiModels(ctx: ListContext, apiKey: string, settings: OpenAiListSettings): Promise<ProviderModelInfo[]> {
  const base = trimBase(settings.baseURL ?? 'https://api.openai.com/v1');
  const raw = await getJson(ctx, `${base}/models`, openAiHeaders(apiKey, settings));
  return parseOpenAiListing(ctx, raw, isOpenAiChatModel);
}
