import { z } from 'zod';
import type { ProviderModelInfo } from '../contract/types.js';
import { getJson, invalidListing, MAX_LIST_PAGES, type ListContext } from './http.js';

/**
 * Google Vertex AI Model Garden (research/09 §4):
 * `GET https://<host>/v1/publishers/<publisher>/models` (publishers.models.list,
 * `pageSize`/`pageToken`, `nextPageToken`) with an OAuth bearer token from the
 * configured service account (or ADC) and `x-goog-user-project` for quota.
 * OCSO's Vertex adapter drives Gemini (publisher `google`) and Claude
 * (publisher `anthropic`), so exactly those two publishers are listed.
 *
 * Rules: Google models must be `gemini-*` and not embedding, TTS, image
 * generation or live/native-audio variants; Anthropic models must be
 * `claude-*`. The listing documents no input modalities or limits.
 */

const Page = z
  .object({
    publisherModels: z
      .array(
        z
          .object({
            name: z.string().min(1),
            versionId: z.string().optional(),
            launchStage: z.string().optional(),
            versionState: z.string().optional(),
          })
          .loose(),
      )
      .optional(),
    nextPageToken: z.string().optional(),
  })
  .loose();

export const VERTEX_PUBLISHERS = ['google', 'anthropic'] as const;

const GEMINI_NON_CHAT = /(embedding|tts|image|live|native-audio)/i;

/** Only chat models the adapter can call. */
export function isVertexChatModel(publisher: string, id: string): boolean {
  if (publisher === 'google') return /^gemini-/i.test(id) && !GEMINI_NON_CHAT.test(id);
  if (publisher === 'anthropic') return /^claude-/i.test(id);
  return false;
}

/** Service endpoint for a location: `global` and multi-regions use the global host. */
export function vertexHost(location: string): string {
  return location === 'global' || !location.includes('-') ? 'https://aiplatform.googleapis.com' : `https://${location}-aiplatform.googleapis.com`;
}

type Item = NonNullable<z.infer<typeof Page>['publisherModels']>[number];

/**
 * Model id to call. Claude snapshots before the 4.6 generation are called as
 * `claude-…@YYYYMMDD` on Vertex, so a date `versionId` is appended; later
 * (dateless) Claude ids and Gemini ids are used as listed.
 */
export function vertexModelId(publisher: string, item: Item): string {
  const base = item.name.split('/').pop() ?? item.name;
  if (publisher === 'anthropic' && item.versionId && /^\d{8}$/.test(item.versionId) && !base.includes('@')) return `${base}@${item.versionId}`;
  return base;
}

function lifecycleOf(item: Item): ProviderModelInfo['lifecycle'] {
  const stage = item.launchStage?.toUpperCase();
  if (stage === 'DEPRECATED' || item.versionState?.toUpperCase() === 'VERSION_STATE_DEPRECATED') return 'DEPRECATED';
  return stage ? 'ACTIVE' : undefined;
}

export function toVertexModels(publisher: string, items: readonly Item[]): ProviderModelInfo[] {
  return items
    .map((item) => ({ item, id: vertexModelId(publisher, item) }))
    .filter(({ id }) => isVertexChatModel(publisher, id))
    .map(({ item, id }) => {
      const lifecycle = lifecycleOf(item);
      return {
        id,
        displayName: null,
        createdAt: null,
        ownedBy: publisher,
        kind: 'model' as const,
        ...(lifecycle ? { lifecycle } : {}),
      };
    });
}

export interface VertexListAuth {
  project: string;
  location: string;
  token: () => Promise<string>;
}

export async function listVertexModels(ctx: ListContext, auth: VertexListAuth): Promise<ProviderModelInfo[]> {
  const host = vertexHost(auth.location);
  const out: ProviderModelInfo[] = [];
  for (const publisher of VERTEX_PUBLISHERS) {
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const query = new URLSearchParams({ pageSize: '100', ...(pageToken ? { pageToken } : {}) });
      const headers = { authorization: `Bearer ${await auth.token()}`, 'x-goog-user-project': auth.project };
      const parsed = Page.safeParse(await getJson(ctx, `${host}/v1/publishers/${publisher}/models?${query}`, headers));
      if (!parsed.success) throw invalidListing(ctx);
      out.push(...toVertexModels(publisher, parsed.data.publisherModels ?? []));
      if (!parsed.data.nextPageToken) break;
      pageToken = parsed.data.nextPageToken;
    }
  }
  // listAllVersions is off, but guard against duplicates across pages.
  return [...new Map(out.map((m) => [m.id, m])).values()];
}
