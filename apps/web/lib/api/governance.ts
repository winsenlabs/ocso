import 'server-only';
import { z } from 'zod';
import { ProposedSchema } from '@/components/approvals/lib/schemas';
import { api } from './client';

/** GET /v1/settings/retention — retention classes with defaults, floors and effective days (docs/15 §8). */
export const RetentionClassSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  days: z.number(),
  defaultDays: z.number(),
  minDays: z.number(),
  overridden: z.boolean(),
});
export type RetentionClass = z.infer<typeof RetentionClassSchema>;

/** Ask OCSO settings: its model profile and the writes kill switch (`askOcsoWrites`, default on; reads always work). */
const AssistantSettingsSchema = z.object({ internalAgentProfileId: z.string().nullable(), askOcsoWrites: z.boolean().optional().default(true) });
export type AssistantSettings = z.infer<typeof AssistantSettingsSchema>;

export const getRetention = () => api.get('/v1/settings/retention', z.array(RetentionClassSchema));

/** The Ask OCSO settings live on the deployment settings singleton. */
export const getAssistantSettings = () => api.get('/v1/settings/deployment', AssistantSettingsSchema);

/** A settings change is a proposal (202) naming its checker (PM/research/11 §4). */
export const updateGovernance = (patch: { retention?: Record<string, number>; internalAgentProfileId?: string | null; askOcsoWrites?: boolean; approval: { checkerId: string; reason: string } | { bootstrap: true; reason: string } }) =>
  api.patch('/v1/settings/deployment', patch, z.union([ProposedSchema, z.unknown()]));
