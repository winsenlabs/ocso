import { z } from 'zod';

/** Corrections, reviews and replay evaluations (apps/api/src/modules/quality, packages/application/src/quality). */

export const CORRECTION_STATUSES = ['OPEN', 'STAGED', 'APPLIED', 'REJECTED'] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

export const CorrectionSchema = z.object({
  id: z.string(),
  agentId: z.string(),
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

export const ReviewSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  displayId: z.string(),
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

export const EVALUATION_STATUSES = ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'] as const;

export const EvaluationRunSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  baselineVersionId: z.string().nullable(),
  status: z.enum(EVALUATION_STATUSES),
  caseCount: z.number(),
  summary: z.record(z.string(), z.number()).nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  createdByName: z.string().nullable(),
  baselineVersion: z.number().nullable(),
  summaryDefinition: z.string(),
});
export type EvaluationRun = z.infer<typeof EvaluationRunSchema>;

export const EvaluationResultSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  seq: z.number(),
  customerText: z.string(),
  baselineText: z.string().nullable(),
  candidateText: z.string().nullable(),
  changed: z.boolean(),
  flags: z.array(z.string()).nullable(),
});
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;
