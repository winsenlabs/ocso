import 'server-only';
import { z } from 'zod';
import { CapabilityAreaSchema, ProfileOptionSchema, SuggestionSchema, type CapabilityArea, ThreadSummarySchema, type ProfileOption, type Suggestion, type ThreadSummary } from '@/components/internal-agent/types';
import type { StoredMessage } from '@/components/internal-agent/history';
import { CARD_DECISION_TIMEOUT_MS, readActionAnswer, readCardStatus, type ActionAnswer, type CardStatusRead } from '@/components/internal-agent/decisions';
import { ProposedSchema } from '@/components/approvals/lib/schemas';
import { api } from './client';

/**
 * Internal OCSO agent API (docs/12; apps/api internal-agent controller).
 * The chat stream itself is proxied by app/api/internal-agent/chat.
 */

/** GET /v1/internal-agent/threads — the caller's own threads, newest first. */
export function listInternalAgentThreads(): Promise<ThreadSummary[]> {
  return api.get('/v1/internal-agent/threads', z.array(ThreadSummarySchema.loose())).then((rows) =>
    rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt })),
  );
}

const StoredMessageSchema = z.object({
  id: z.string(),
  role: z.string(),
  parts: z.array(z.unknown()),
});

/** GET /v1/internal-agent/threads/:id/messages (404 for someone else's thread). */
export function getInternalAgentMessages(threadId: string): Promise<StoredMessage[]> {
  return api.get(`/v1/internal-agent/threads/${encodeURIComponent(threadId)}/messages`, z.array(StoredMessageSchema));
}

/** Governed cards carry the checker the user chose and why (PM/research/12 §5); other cards send nothing. */
export interface ConfirmInput {
  checkerId?: string | undefined;
  reason?: string | undefined;
  /** Values typed into the card's credential fields: sent with this one request, never logged or kept. */
  credentials?: Record<string, string> | undefined;
}

/**
 * POST /v1/internal-agent/actions/:id/confirm — the API re-checks the card (single use, not expired, object unchanged)
 * and runs the real route as this user: a direct or stop card applies, a governed card becomes a proposal to the checker.
 */
export async function confirmInternalAgentAction(actionId: string, input: ConfirmInput = {}): Promise<ActionAnswer> {
  const body = {
    ...(input.checkerId ? { checkerId: input.checkerId } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.credentials && Object.keys(input.credentials).length ? { credentials: input.credentials } : {}),
  };
  // The API's own confirm can run a snapshot read and then a slow route (a copilot draft, a bulk approval): wait past its bound.
  return readActionAnswer(await api.post(`/v1/internal-agent/actions/${encodeURIComponent(actionId)}/confirm`, body, z.unknown(), { timeoutMs: CARD_DECISION_TIMEOUT_MS }), 'confirm');
}

/** POST /v1/internal-agent/actions/:id/reject — 204, or the card marked REJECTED. */
export async function rejectInternalAgentAction(actionId: string): Promise<ActionAnswer> {
  return readActionAnswer(await api.post(`/v1/internal-agent/actions/${encodeURIComponent(actionId)}/reject`, undefined, z.unknown(), { timeoutMs: CARD_DECISION_TIMEOUT_MS }), 'reject');
}

/** GET /v1/internal-agent/actions/:id — where the caller's card stands now, and whether a confirm is still running. */
export async function getInternalAgentAction(actionId: string): Promise<CardStatusRead> {
  return readCardStatus(await api.get(`/v1/internal-agent/actions/${encodeURIComponent(actionId)}`, z.unknown()));
}

const SuggestionsBodySchema = z.union([
  z.array(z.unknown()),
  z.object({ suggestions: z.array(z.unknown()) }).transform((b) => b.suggestions),
  z.object({ rows: z.array(z.unknown()) }).transform((b) => b.rows),
]);

/** One chip from whatever the endpoint gives: a string, or `{ label, prompt? }`. Anything else is dropped. */
function toSuggestion(raw: unknown): Suggestion | null {
  if (typeof raw === 'string') return raw.trim() ? { label: raw.trim(), prompt: raw.trim() } : null;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { label?: unknown; prompt?: unknown; question?: unknown; summary?: unknown };
  const label = [r.label, r.question, r.summary].find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  if (!label) return null;
  const prompt = [r.prompt, r.question].find((v): v is string => typeof v === 'string' && v.trim().length > 0) ?? label;
  const parsed = SuggestionSchema.safeParse({ label: label.trim().slice(0, 120), prompt: prompt.trim().slice(0, 500) });
  return parsed.success ? parsed.data : null;
}

/** What the drawer needs for "What can you do?": the chips, and the per-area answer from the catalog (null when absent). */
export interface InternalAgentCapabilities {
  suggestions: Suggestion[];
  areas: CapabilityArea[] | null;
  /** The deployment's writes switch as the endpoint reports it; null when an older API does not say. */
  writesOn: boolean | null;
}

const AreasBodySchema = z.object({ areas: z.array(z.unknown()) });

/** GET /v1/internal-agent/capabilities/suggestions — "What can you do?" chips and areas for the caller's permissions. */
export async function getInternalAgentCapabilities(): Promise<InternalAgentCapabilities> {
  const body = await api.get('/v1/internal-agent/capabilities/suggestions', z.unknown());
  const rows = SuggestionsBodySchema.safeParse(body);
  if (!rows.success) throw rows.error;
  const seen = new Set<string>();
  const suggestions = rows.data.flatMap((r) => {
    const s = toSuggestion(r);
    if (!s || seen.has(s.label)) return [];
    seen.add(s.label);
    return [s];
  });
  const rawAreas = AreasBodySchema.safeParse(body);
  const areas = rawAreas.success
    ? rawAreas.data.areas.flatMap((a) => {
        const p = CapabilityAreaSchema.safeParse(a);
        return p.success && p.data.reads + p.data.writes > 0 ? [p.data] : [];
      })
    : null;
  const writesOn = z.object({ writesOn: z.boolean() }).safeParse(body);
  return { suggestions, areas: areas?.length ? areas : null, writesOn: writesOn.success ? writesOn.data.writesOn : null };
}

/** The chips alone. */
export async function listInternalAgentSuggestions(): Promise<Suggestion[]> {
  return (await getInternalAgentCapabilities()).suggestions;
}

/** Deployment settings for Ask OCSO: whether a model profile is named (`internalAgentProfileId`) and whether writes are on. */
export async function internalAgentDeployment(): Promise<{ configured: boolean; writesOn: boolean }> {
  const settings = await api.get('/v1/settings/deployment', z.object({ internalAgentProfileId: z.string().nullable().optional(), askOcsoWrites: z.boolean().optional() }));
  return { configured: Boolean(settings.internalAgentProfileId), writesOn: settings.askOcsoWrites ?? true };
}


/** GET /v1/model-profiles, reduced to what the setup picker shows. */
export async function listProfileOptions(): Promise<ProfileOption[]> {
  const rows = await api.get('/v1/model-profiles', z.array(ProfileOptionSchema.loose()));
  return rows.map((p) => ({ id: p.id, name: p.name, model: p.model, providerName: p.providerName }));
}

/** PATCH /v1/settings/deployment { internalAgentProfileId, approval } (deployment_settings.manage): a proposal (202) — true when proposed. */
export async function setInternalAgentProfile(profileId: string, approval?: { checkerId: string; reason: string } | { bootstrap: true; reason?: string | undefined }): Promise<boolean> {
  const res = await api.patch('/v1/settings/deployment', { internalAgentProfileId: profileId, ...(approval ? { approval } : {}) }, z.union([ProposedSchema, z.object({ internalAgentProfileId: z.string().nullable() }).loose()]));
  return 'proposal' in res && (res as { proposal: { status: string } }).proposal.status === 'SUBMITTED';
}
