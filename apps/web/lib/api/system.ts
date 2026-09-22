import 'server-only';
import { notYetAvailable } from './pending';

export interface AdminMetrics {
  uptime30d: number;
  healthyWorkers: number;
  totalWorkers: number;
  activeConversations: number;
  ttftP95Ms: number;
  tokensToday: number;
  openIncidents: number;
}

export interface CapacityNow {
  slotsUsed: number;
  slotsTotal: number;
  queueDepth: number;
  oldestQueueAgeSeconds: number;
}

export interface ConnectionsSummary {
  mcp: { servers: number; tools: number; degraded: number };
  llm: { providers: number; profiles: number; elevated: number };
  channels: { count: number; unverified: number };
}

export interface PrivilegedChange {
  id: string;
  at: string;
  summary: string;
  actorName: string;
  auditRef: string;
}

export function loadAdminMetrics(): Promise<AdminMetrics | null> {
  return notYetAvailable('GET /v1/telemetry/summary');
}

export function loadCapacityNow(): Promise<CapacityNow | null> {
  return notYetAvailable('GET /v1/workers/capacity');
}

export function loadConnectionsSummary(): Promise<ConnectionsSummary | null> {
  return notYetAvailable('GET /v1/connections/summary');
}

export function loadPrivilegedChanges(): Promise<PrivilegedChange[] | null> {
  return notYetAvailable('GET /v1/audit?privileged=true&limit=5');
}
