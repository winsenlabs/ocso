import 'server-only';
import { z } from 'zod';
import { api } from './client';

/* ───────────── Reviews (apps/api quality/reviews.controller.ts, packages/application quality/reviews.ts) ───────────── */

export const ReviewSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  displayId: z.string(),
  agent: z.object({ id: z.string(), name: z.string() }),
  reviewer: z.object({ id: z.string(), name: z.string() }),
  customerName: z.string().nullable(),
  controlState: z.string(),
  rubric: z.record(z.string(), z.number()),
  score: z.number(),
  outcomeTag: z.string(),
  notes: z.string().nullable(),
  createdAt: z.string(),
});
export type Review = z.infer<typeof ReviewSchema>;

export const RubricSchema = z.object({
  criteria: z.record(z.string(), z.string()),
  scale: z.object({ min: z.number(), max: z.number() }),
  outcomeTags: z.array(z.string()),
  scoreDefinition: z.string(),
});
export type Rubric = z.infer<typeof RubricSchema>;

export interface ReviewRequest {
  conversationId: string;
  rubric: { accuracy: number; policy: number; tone: number; resolution: number };
  outcomeTag: string;
  notes?: string;
}

export function listReviews(q: { agentId?: string | undefined; conversationId?: string | undefined; limit?: number } = {}): Promise<Review[]> {
  const params = new URLSearchParams({ limit: String(q.limit ?? 100) });
  if (q.agentId) params.set('agentId', q.agentId);
  if (q.conversationId) params.set('conversationId', q.conversationId);
  return api.get(`/v1/reviews?${params.toString()}`, z.array(ReviewSchema));
}

export function loadRubric(): Promise<Rubric> {
  return api.get('/v1/reviews/rubric', RubricSchema);
}

export function createReview(input: ReviewRequest): Promise<Review> {
  return api.post('/v1/reviews', input, ReviewSchema);
}

/* ───────────── Prompt corrections (quality/corrections.controller.ts, quality/corrections.ts) ───────────── */

export const CORRECTION_STATUSES = ['OPEN', 'STAGED', 'APPLIED', 'REJECTED'] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

/** Business prompt components (packages/prompt-compiler BUSINESS_COMPONENT_KEYS). */
export const COMPONENT_KEYS = ['identity', 'objective', 'behavior', 'policies', 'tool_instructions', 'escalation', 'channel_constraints', 'business_context'] as const;
export type ComponentKey = (typeof COMPONENT_KEYS)[number];

export const CorrectionSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  conversationId: z.string().nullable(),
  interactionSeq: z.number().nullable(),
  title: z.string(),
  observed: z.string(),
  desired: z.string(),
  componentKey: z.string(),
  proposedText: z.string().nullable(),
  status: z.enum(CORRECTION_STATUSES),
  source: z.string(),
  occurrences: z.number(),
  resultingVersionId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Correction = z.infer<typeof CorrectionSchema>;

export interface CorrectionRequest {
  agentId?: string;
  conversationId?: string;
  interactionSeq?: number;
  title?: string;
  observed: string;
  desired: string;
  componentKey: ComponentKey;
  proposedText?: string;
}

export function listCorrections(q: { status?: CorrectionStatus | undefined; agentId?: string | undefined } = {}): Promise<Correction[]> {
  const params = new URLSearchParams({ limit: '200' });
  if (q.status) params.set('status', q.status);
  if (q.agentId) params.set('agentId', q.agentId);
  return api.get(`/v1/corrections?${params.toString()}`, z.array(CorrectionSchema));
}

export function createCorrection(input: CorrectionRequest): Promise<{ id: string; merged: boolean }> {
  return api.post('/v1/corrections', input, z.object({ id: z.string(), merged: z.boolean() }));
}

export function stageCorrection(id: string, input: { proposedText?: string; mode: 'APPEND' | 'REPLACE' }): Promise<{ componentKey: string; changed: boolean }> {
  return api.post(`/v1/corrections/${encodeURIComponent(id)}/stage`, input, z.object({ componentKey: z.string(), changed: z.boolean() }));
}

export function rejectCorrection(id: string, reason: string | undefined): Promise<void> {
  return api.command('POST', `/v1/corrections/${encodeURIComponent(id)}/reject`, reason ? { reason } : {});
}

/* ───────────── Virtual agents as options (GET /v1/agents, agents.read) ───────────── */

const AgentOption = z.object({ id: z.string(), name: z.string(), status: z.string() });
export type AgentOption = z.infer<typeof AgentOption>;

export function listAgentOptions(): Promise<AgentOption[]> {
  return api.get('/v1/agents', z.array(AgentOption));
}
