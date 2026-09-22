import 'server-only';
import { z } from 'zod';
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

const AssistantSettingsSchema = z.object({ internalAgentProfileId: z.string().nullable(), internalAgentConfirmLowWrites: z.boolean() });
export type AssistantSettings = z.infer<typeof AssistantSettingsSchema>;

export const getRetention = () => api.get('/v1/settings/retention', z.array(RetentionClassSchema));

/** The Ask OCSO settings live on the deployment settings singleton. */
export const getAssistantSettings = () => api.get('/v1/settings/deployment', AssistantSettingsSchema);

export const updateGovernance = (patch: { retention?: Record<string, number>; internalAgentProfileId?: string | null; internalAgentConfirmLowWrites?: boolean }) =>
  api.command('PATCH', '/v1/settings/deployment', patch);
