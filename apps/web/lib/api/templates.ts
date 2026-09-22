import 'server-only';
import { MessageTemplateSchema } from '@ocso/domain';
import { z } from 'zod';
import { api } from './client';

/* ───────────── WhatsApp templates (packages/application/src/channels/templates*.ts) ───────────── */

export const TemplateViewSchema = MessageTemplateSchema.extend({
  submission: z
    .object({
      recordId: z.string(),
      submittedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
      submittedAt: z.string(),
      statusChangedAt: z.string().nullable(),
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

export const TemplateChannelSchema = z.object({ id: z.string(), kind: z.string(), name: z.string(), status: z.string(), kindLabel: z.string() });
export type TemplateChannel = z.infer<typeof TemplateChannelSchema>;

/** GET /v1/channels/:id/templates (cached ~5 min by the API; refresh refetches from the provider). */
export function loadChannelTemplates(channelId: string, refresh = false): Promise<TemplateList> {
  return api.get(`/v1/channels/${encodeURIComponent(channelId)}/templates${refresh ? '?refresh=true' : ''}`, TemplateListSchema, { timeoutMs: 30_000 });
}

/** Channels whose templates this user may manage (whatsapp_templates.manage, team-scoped for CS Leads). */
export function loadTemplateChannels(): Promise<TemplateChannel[]> {
  return api.get('/v1/whatsapp-templates/channels', z.array(TemplateChannelSchema));
}
