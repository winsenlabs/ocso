import 'server-only';
import { MessageTemplateSchema } from '@ocso/domain';
import { z } from 'zod';
import { TemplateTermsSchema } from './channels';
import { api } from './client';

/* ───────────── Message templates (packages/application/src/channels/message-templates*.ts) ───────────── */

export const TemplateViewSchema = MessageTemplateSchema.extend({
  submission: z
    .object({
      recordId: z.string(),
      submittedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
      submittedAt: z.string(),
      statusChangedAt: z.string().nullable(),
      /** Saved in OCSO only: the provider sees it once a checker approves its submission (PM/research/11 §4). */
      draft: z.boolean().default(false),
      providerMade: z.boolean().default(false),
      /** The proposal waiting on it (submit or delete), or an approved one the worker is still finishing. */
      approval: z.object({ proposalId: z.string(), action: z.enum(['CREATE', 'DELETE']), checkerName: z.string().nullable(), activating: z.boolean() }).nullable().default(null),
    })
    .nullable(),
});
export type TemplateView = z.infer<typeof TemplateViewSchema>;

export const TemplateListSchema = z.object({
  channel: z.object({ id: z.string(), kind: z.string(), name: z.string() }),
  templates: z.array(TemplateViewSchema),
  fetchedAt: z.string().nullable(),
  problem: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type TemplateList = z.infer<typeof TemplateListSchema>;

/** A channel whose templates this user manages, with its kind's template terms (descriptor `templates`). */
export const TemplateChannelSchema = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  status: z.string(),
  kindLabel: z.string(),
  templates: TemplateTermsSchema.nullable().catch(null).default(null),
});
export type TemplateChannel = z.infer<typeof TemplateChannelSchema>;

/** GET /v1/channels/:id/templates (cached ~5 min by the API; refresh refetches from the provider). */
export function loadChannelTemplates(channelId: string, refresh = false): Promise<TemplateList> {
  return api.get(`/v1/channels/${encodeURIComponent(channelId)}/templates${refresh ? '?refresh=true' : ''}`, TemplateListSchema, { timeoutMs: 30_000 });
}

/** Channels whose templates this user may manage (message_templates.manage, team-scoped for Leads). */
export function loadTemplateChannels(): Promise<TemplateChannel[]> {
  return api.get('/v1/message-templates/channels', z.array(TemplateChannelSchema));
}
