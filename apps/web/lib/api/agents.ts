import 'server-only';
import { notYetAvailable } from './pending';

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
