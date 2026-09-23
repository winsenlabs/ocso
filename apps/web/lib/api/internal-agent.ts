import 'server-only';
import { z } from 'zod';
import { MiniTableSchema, ObjectLinkSchema, ProfileOptionSchema, ThreadSummarySchema, type ProfileOption, type ThreadSummary } from '@/components/internal-agent/types';
import type { StoredMessage } from '@/components/internal-agent/history';
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

/** What a confirmed action did (the tool's answer; `data` is for the model and not shown). */
export const ActionResultSchema = z.object({
  links: z.array(ObjectLinkSchema).optional(),
  table: MiniTableSchema.optional(),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;

/** POST /v1/internal-agent/actions/:id/confirm — re-authorizes, executes, audits. */
export function confirmInternalAgentAction(actionId: string): Promise<ActionResult> {
  return api.post(`/v1/internal-agent/actions/${encodeURIComponent(actionId)}/confirm`, {}, ActionResultSchema);
}

/** POST /v1/internal-agent/actions/:id/reject (204). */
export function rejectInternalAgentAction(actionId: string): Promise<void> {
  return api.command('POST', `/v1/internal-agent/actions/${encodeURIComponent(actionId)}/reject`);
}

/** Whether deployment settings name a model profile for Ask OCSO (`internalAgentProfileId`). */
export async function internalAgentConfigured(): Promise<boolean> {
  const settings = await api.get('/v1/settings/deployment', z.object({ internalAgentProfileId: z.string().nullable().optional() }));
  return Boolean(settings.internalAgentProfileId);
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
