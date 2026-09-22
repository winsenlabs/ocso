import 'server-only';
import type { ControlState } from '@ocso/domain';
import type { ChannelCode } from '../channels';
import { notYetAvailable } from './pending';

/** SLA clock as the UI renders it (SlaTimer). */
export interface SlaView {
  level: 'ok' | 'risk' | 'breach';
  /** Seconds left (negative once breached). */
  remainingSeconds: number;
  /** Elapsed share of the SLA window, 0–1. */
  progress: number;
}

export interface PickupRow {
  conversationId: string;
  customerName: string;
  /** Channel plus masked identifier, e.g. "whatsapp · +91 98•••41208". */
  customerRef: string;
  channel: ChannelCode;
  agentName: string;
  reason: string;
  waitingSeconds: number;
  sla: SlaView;
}

export interface AssignmentRow {
  conversationId: string;
  customerName: string;
  topic: string;
  agentName: string;
  controlState: ControlState;
  lastTurnAt: string;
  sla: SlaView | null;
}

export interface ResolvedRow {
  conversationId: string;
  customerName: string;
  summary: string;
  resolvedAt: string;
  csat: number | null;
}

export interface ExecMetrics {
  assignedToMe: number;
  waitingForHuman: number;
  slaBreached: number;
  resolvedToday: number;
  firstResponseSeconds: number | null;
  csat7d: number | null;
}

export function loadPickupQueue(): Promise<PickupRow[] | null> {
  return notYetAvailable('GET /v1/conversations?view=pickup');
}

export function loadMyAssignments(): Promise<AssignmentRow[] | null> {
  return notYetAvailable('GET /v1/conversations?view=assigned_to_me');
}

export function loadRecentlyResolved(): Promise<ResolvedRow[] | null> {
  return notYetAvailable('GET /v1/conversations?view=resolved_by_me');
}

export function loadExecMetrics(): Promise<ExecMetrics | null> {
  return notYetAvailable('GET /v1/analytics/me');
}
