import { AwsV4Signer } from 'aws4fetch';
import { z } from 'zod';
import type { ModelInputKind, ProviderModelInfo } from '../contract/types.js';
import { getJson, invalidListing, MAX_LIST_PAGES, type ListContext } from './http.js';

/**
 * AWS Bedrock control plane (research/09 §3): `GET /foundation-models`
 * (ListFoundationModels) and `GET /inference-profiles` (ListInferenceProfiles)
 * on `bedrock.<region>.amazonaws.com`, SigV4-signed with the configured
 * credentials (aws4fetch, the signer the AI SDK Bedrock provider uses) or a
 * Bedrock API key as a bearer token.
 *
 * Rules: foundation models must output TEXT, accept TEXT, not be embedding
 * models, and support ON_DEMAND invocation (models reachable only through an
 * inference profile are listed as their profiles instead). Input kinds come
 * from the documented `inputModalities`.
 */

const FoundationModels = z.object({
  modelSummaries: z.array(
    z
      .object({
        modelId: z.string().min(1),
        modelName: z.string().optional(),
        providerName: z.string().optional(),
        inputModalities: z.array(z.string()).optional(),
        outputModalities: z.array(z.string()).optional(),
        inferenceTypesSupported: z.array(z.string()).optional(),
        modelLifecycle: z.object({ status: z.string().optional() }).loose().optional(),
      })
      .loose(),
  ),
});

const Profiles = z.object({
  inferenceProfileSummaries: z.array(
    z
      .object({
        inferenceProfileId: z.string().min(1),
        inferenceProfileArn: z.string().optional(),
        inferenceProfileName: z.string().optional(),
        createdAt: z.string().optional(),
        status: z.string().optional(),
        type: z.string().optional(),
        models: z.array(z.object({ modelArn: z.string() }).loose()).optional(),
      })
      .loose(),
  ),
  nextToken: z.string().nullable().optional(),
});

export type BedrockAuth =
  | { mode: 'API_KEY'; apiKey: string }
  | { mode: 'SIGV4'; credentials: () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string | undefined }> };

const MODALITY: Readonly<Record<string, ModelInputKind>> = { TEXT: 'text', IMAGE: 'image', DOCUMENT: 'pdf', AUDIO: 'audio', VIDEO: 'video', SPEECH: 'audio' };

function inputKinds(modalities: readonly string[] | undefined): ModelInputKind[] | undefined {
  if (!modalities?.length) return undefined;
  const kinds = [...new Set(modalities.map((m) => MODALITY[m.toUpperCase()]).filter((k): k is ModelInputKind => k !== undefined))];
  return kinds.length ? kinds : undefined;
}

function lifecycleOf(status: string | undefined): ProviderModelInfo['lifecycle'] {
  if (!status) return undefined;
  const s = status.toUpperCase();
  return s === 'LEGACY' ? 'LEGACY' : s === 'ACTIVE' ? 'ACTIVE' : undefined;
}

/** `arn:aws:bedrock:<region>::foundation-model/<modelId>` → modelId. */
const modelIdFromArn = (arn: string) => /foundation-model\/(.+)$/.exec(arn)?.[1];

async function authHeaders(auth: BedrockAuth, url: string, region: string): Promise<Record<string, string>> {
  if (auth.mode === 'API_KEY') return { authorization: `Bearer ${auth.apiKey}` };
  const c = await auth.credentials();
  const signed = await new AwsV4Signer({
    url,
    method: 'GET',
    service: 'bedrock',
    region,
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}),
  }).sign();
  return Object.fromEntries(signed.headers.entries());
}

async function signedGet(ctx: ListContext, auth: BedrockAuth, region: string, url: string): Promise<unknown> {
  return getJson(ctx, url, await authHeaders(auth, url, region));
}

export function toFoundationModels(raw: unknown, ctx: Pick<ListContext, 'kind' | 'providerId'>): ProviderModelInfo[] {
  const parsed = FoundationModels.safeParse(raw);
  if (!parsed.success) throw invalidListing(ctx);
  return parsed.data.modelSummaries
    .filter((m) => (m.outputModalities ?? []).includes('TEXT'))
    .filter((m) => (m.inputModalities ?? ['TEXT']).includes('TEXT'))
    .filter((m) => !/embed/i.test(m.modelId))
    .filter((m) => (m.inferenceTypesSupported ?? []).includes('ON_DEMAND'))
    .map((m) => {
      const input = inputKinds(m.inputModalities);
      const lifecycle = lifecycleOf(m.modelLifecycle?.status);
      return {
        id: m.modelId,
        displayName: m.modelName ?? null,
        createdAt: null,
        ownedBy: m.providerName ?? null,
        kind: 'model' as const,
        ...(input ? { input } : {}),
        ...(lifecycle ? { lifecycle } : {}),
      };
    });
}

/** Profiles whose underlying model is a listed text model (so no embedding/image profiles). */
export function toInferenceProfiles(
  summaries: z.infer<typeof Profiles>['inferenceProfileSummaries'],
  textModels: ReadonlySet<string>,
  inputByModel: ReadonlyMap<string, readonly ModelInputKind[]>,
): ProviderModelInfo[] {
  return summaries
    .filter((p) => !p.status || p.status.toUpperCase() === 'ACTIVE')
    .map((p) => ({ p, baseModel: p.models?.map((m) => modelIdFromArn(m.modelArn)).find((m): m is string => m !== undefined) }))
    .filter(({ baseModel }) => baseModel !== undefined && textModels.has(baseModel) && !/embed/i.test(baseModel))
    .map(({ p, baseModel }) => {
      // Application profiles are invoked by ARN; system-defined ones by id (us.anthropic.…).
      const id = p.type === 'APPLICATION' && p.inferenceProfileArn ? p.inferenceProfileArn : p.inferenceProfileId;
      const input = baseModel ? inputByModel.get(baseModel) : undefined;
      return {
        id,
        displayName: p.inferenceProfileName ?? null,
        createdAt: p.createdAt ?? null,
        ownedBy: p.type === 'APPLICATION' ? 'application inference profile' : 'cross-region inference profile',
        kind: 'inference-profile' as const,
        ...(baseModel ? { baseModel } : {}),
        ...(input ? { input: [...input] } : {}),
      };
    });
}

export async function listBedrockModels(ctx: ListContext, auth: BedrockAuth, region: string): Promise<ProviderModelInfo[]> {
  const host = `https://bedrock.${region}.amazonaws.com`;
  const foundationRaw = await signedGet(ctx, auth, region, `${host}/foundation-models?byOutputModality=TEXT`);
  const foundation = FoundationModels.safeParse(foundationRaw);
  if (!foundation.success) throw invalidListing(ctx);
  // Every text model (also the profile-only ones) and its input kinds, for the profile rows.
  const textModels = new Set<string>();
  const inputByModel = new Map<string, readonly ModelInputKind[]>();
  for (const m of foundation.data.modelSummaries) {
    if (!(m.outputModalities ?? []).includes('TEXT')) continue;
    textModels.add(m.modelId);
    const input = inputKinds(m.inputModalities);
    if (input) inputByModel.set(m.modelId, input);
  }
  const profiles: z.infer<typeof Profiles>['inferenceProfileSummaries'] = [];
  let next: string | null = null;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const query = new URLSearchParams({ maxResults: '1000', ...(next ? { nextToken: next } : {}) });
    const parsed = Profiles.safeParse(await signedGet(ctx, auth, region, `${host}/inference-profiles?${query}`));
    if (!parsed.success) throw invalidListing(ctx);
    profiles.push(...parsed.data.inferenceProfileSummaries);
    if (!parsed.data.nextToken) break;
    next = parsed.data.nextToken;
  }
  return [...toFoundationModels(foundationRaw, ctx), ...toInferenceProfiles(profiles, textModels, inputByModel)];
}
