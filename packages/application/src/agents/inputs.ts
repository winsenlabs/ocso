import { BusinessHoursSchema } from '@ocso/domain';
import type { virtualAgents } from '@ocso/db';
import { z } from 'zod';
import type { AgentTeamRef } from './access.js';
import { OwnerTeamIds } from './owners.js';

/** Agent input schemas, apart from AgentService so the approval descriptor can use them without an import cycle. */
const Multimodal = z.object({
  imageInput: z.boolean(),
  documentInput: z.boolean(),
  audioInput: z.boolean(),
  maxMediaPerTurn: z.number().int().min(0).max(20),
});

export const AgentFields = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/).optional(),
  purpose: z.string().trim().max(200),
  conversationType: z.enum(['SUPPORT', 'SALES', 'COLLECTIONS', 'ONBOARDING', 'CUSTOM']),
  description: z.string().max(2_000),
  modelProfileId: z.uuid().nullable().optional(),
  summarizerProfileId: z.uuid().nullable().optional(),
  copilotProfileId: z.uuid().nullable().optional(),
  defaultQueueId: z.uuid().nullable().optional(),
  multimodal: Multimodal.optional(),
  midTurnPolicy: z.enum(['QUEUE_BEHIND', 'CANCEL_AND_RESTART']).optional(),
  maxToolSteps: z.number().int().min(1).max(20).optional(),
  copilotEnabled: z.boolean().optional(),
  /** Deprecated: channels reach agents through routers (PM/research/11 §5); a non-empty list is refused. */
  channelIds: z.array(z.uuid()).optional(),
  /** When humans take handoffs (IANA zone + per-day HH:MM spans); `humanHours: {}` = humans 24×7. The AI answers 24×7. */
  businessHours: BusinessHoursSchema.optional(),
  /** Owning teams (ADR-026). Create: required, teams the creating lead belongs to. Update: the owner-change rules in owners.ts. */
  teamIds: OwnerTeamIds.optional(),
});
export const AgentInput = AgentFields.extend({
  purpose: AgentFields.shape.purpose.default(''),
  description: AgentFields.shape.description.default(''),
  teamIds: OwnerTeamIds,
});
export type AgentInput = z.infer<typeof AgentInput>;
/** No defaults: zod 4 applies `.default()` inside `.partial()`, which would blank fields a patch leaves out. */
export const AgentPatch = AgentFields.partial();
export type AgentPatch = z.infer<typeof AgentPatch>;

export type AgentRow = typeof virtualAgents.$inferSelect;
/** An agent as the API returns it: the row plus its owning teams (ADR-026). */
export type AgentView = AgentRow & { teams: AgentTeamRef[] };

/**
 * The payload of an approved agent UPDATE: the patch without owning teams
 * (owners change through PUT /v1/agents/:id/owners, a governance action),
 * strict so a stray field is refused rather than silently dropped.
 */
export const AgentApprovalPatch = AgentPatch.omit({ teamIds: true }).strict();
