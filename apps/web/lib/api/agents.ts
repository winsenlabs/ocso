import 'server-only';
import { z } from 'zod';
import {
  AgentDetailSchema,
  AgentSchema,
  AgentToolsSchema,
  AlertPageSchema,
  DiffSchema,
  EscalationRuleSchema,
  PreviewSchema,
  PromptSchema,
  QueueSchema,
  SlaPolicySchema,
} from '@/components/agents/data/agent-schemas';
import { AgentAnalyticsSchema, ComparisonSchema } from '@/components/agents/data/analytics-schemas';
import { CorrectionSchema, EvaluationResultSchema, EvaluationRunSchema, ReviewSchema, RubricSchema } from '@/components/agents/data/quality-schemas';
import { api } from './client';
import { ApiError } from './errors';
import { notYetAvailable } from './pending';

/**
 * Virtual agents (design/02): agents, structured prompts and versions,
 * escalation rules, tool grants, analytics and quality. Every response is
 * validated against the contracts in components/agents/data.
 */

const enc = encodeURIComponent;
const agentPath = (id: string) => `/v1/agents/${enc(id)}`;

/** Reads a role may not have (403) or data that no longer exists (404) resolve to null. */
export async function optional<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof ApiError && (err.isForbidden || err.status === 404)) return null;
    throw err;
  }
}

export const listAgents = () => api.get('/v1/agents', z.array(AgentSchema));
export const getAgent = (id: string) => api.get(agentPath(id), AgentDetailSchema);

export const getPrompt = (id: string) => api.get(`${agentPath(id)}/prompt`, PromptSchema);
export const getPromptPreview = (id: string) => api.get(`${agentPath(id)}/prompt/preview`, PreviewSchema);
export const getPromptDiff = (id: string, from: string, to: string) =>
  api.get(`${agentPath(id)}/prompt/diff?from=${enc(from)}&to=${enc(to)}`, DiffSchema);

export const listEscalationRules = (id: string) => api.get(`${agentPath(id)}/escalation-rules`, z.array(EscalationRuleSchema));
export const getAgentTools = (id: string) => api.get(`${agentPath(id)}/tools`, AgentToolsSchema);

export const listQueues = () => api.get('/v1/queues', z.array(QueueSchema));
export const listSlaPolicies = () => api.get('/v1/sla-policies', z.array(SlaPolicySchema));
export const listAgentAlerts = (id: string) => api.get(`/v1/alerts?agentId=${enc(id)}&status=UNRESOLVED&limit=20`, AlertPageSchema);

export const getAgentAnalytics = (id: string, days: number) => api.get(`/v1/analytics/agents/${enc(id)}?days=${days}`, AgentAnalyticsSchema);
export const getAgentComparison = (days: number) => api.get(`/v1/analytics/agents?days=${days}`, ComparisonSchema);

export const listCorrections = (agentId: string) => api.get(`/v1/corrections?agentId=${enc(agentId)}&limit=100`, z.array(CorrectionSchema));
export const listReviews = (agentId: string) => api.get(`/v1/reviews?agentId=${enc(agentId)}&limit=50`, z.array(ReviewSchema));
export const getRubric = () => api.get('/v1/reviews/rubric', RubricSchema);

export const listEvaluationRuns = (agentId: string) => api.get(`/v1/evaluations?agentId=${enc(agentId)}&limit=20`, z.array(EvaluationRunSchema));
export const listEvaluationResults = (runId: string, changedOnly: boolean) =>
  api.get(`/v1/evaluations/${enc(runId)}/results?changedOnly=${changedOnly}&limit=100`, z.array(EvaluationResultSchema));

// ─────────── Home (design/06) — shapes the lead home renders; not wired to the API yet ───────────

export type AgentTone = 'indigo' | 'violet' | 'rose' | 'amber' | 'emerald' | 'sky' | 'teal';

export interface AgentSummary {
  id: string;
  name: string;
  purpose: string;
  promptVersion: number;
  tone: AgentTone;
  state: 'live' | 'paused' | 'sla_risk';
  conversations: number;
  containmentRate: number;
  csat: number | null;
  openAlerts: number;
  slaBreaches: number;
  channels: string[];
}

export interface LeadMetrics {
  conversations7d: number;
  containmentRate: number;
  escalationRate: number;
  slaBreaches: number;
  csat: number | null;
  correctionsStaged: number;
}

export interface EscalationReason {
  reason: string;
  count: number;
  tone: 'default' | 'warn' | 'danger';
}

export function loadAgentSummaries(): Promise<AgentSummary[] | null> {
  return notYetAvailable('GET /v1/agents?include=metrics');
}

export function loadLeadMetrics(): Promise<LeadMetrics | null> {
  return notYetAvailable('GET /v1/analytics/business');
}

export function loadEscalationReasons(): Promise<EscalationReason[] | null> {
  return notYetAvailable('GET /v1/analytics/escalation-reasons');
}
