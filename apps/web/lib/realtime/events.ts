/**
 * Staff realtime events as the browser receives them from /api/realtime
 * (proxy of GET /v1/realtime/stream). Mirrors the envelope and the payloads
 * of packages/events/src/catalogue.ts that UI screens react to; payloads carry
 * ids and small facts only — screens refetch details through the API.
 */

export interface RealtimePayloads {
  'interaction.received': { interactionId: string; seq: number; actorType: string; channelId: string | null };
  'interaction.sent': { interactionId: string; seq: number; actorType: 'AGENT' | 'HUMAN' };
  'interaction.delivery_updated': { interactionId: string; status: string; errorCode?: string };
  'conversation.created': { customerId: string; channelId: string | null; queueId: string | null };
  'conversation.updated': { fields: string[] };
  'conversation.control_changed': { from: string; to: string; command: string; actorType: string; actorId: string | null };
  'conversation.resolved': { disposition: string | null; resolvedBy: string | null };
  'agent.turn_started': { turnId: string; workerId: string };
  'agent.status': { turnId: string; status: 'THINKING' | 'CALLING_TOOL' | 'WRITING' | 'WAITING_CONFIRMATION' };
  /** Ephemeral: streamed text delta of the AI reply being written. */
  'agent.response_delta': { turnId: string; interactionId: string; delta: string };
  'agent.turn_completed': { turnId: string; outcome: 'REPLIED' | 'HANDOFF' | 'NO_REPLY' | 'FAILED' | 'CANCELLED' };
  'tool.started': { toolCallId: string; toolName: string; connectionId: string | null };
  'tool.completed': { toolCallId: string; toolName: string; latencyMs: number };
  'tool.failed': { toolCallId: string; toolName: string; errorCategory: string };
  'tool.confirmation_requested': { toolCallId: string; toolName: string };
  'tool.confirmation_decided': { toolCallId: string; decision: 'APPROVED' | 'DENIED' | 'EXPIRED'; userId: string | null };
  'handoff.requested': { handoffId: string; trigger: string; reason: string; priority: string };
  'handoff.assigned': { handoffId: string; mode: string; queueId: string; userId: string | null };
  'assignment.changed': { userId: string | null; previousUserId: string | null; kind: string };
  'human.message_sent': { interactionId: string; userId: string };
  'note.added': { noteId: string; userId: string };
  'ai.resumed': { handoffId: string | null };
  'copilot.suggestion': { suggestionId: string };
  'alert.opened': { alertId: string; severity: string; kind: 'TECHNICAL' | 'BUSINESS' };
  'alert.updated': { alertId: string; status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' };
  'alert.resolved': { alertId: string };
  'config.changed': { area: string; entityId: string | null };
  /** A message template's review result changed (sent to the submitter and Tech admins). */
  'message_template.status_changed': { templateId: string; channelId: string; name: string; language: string; status: string; previousStatus: string; submittedBy: string | null };
  /** Maker–checker (sent to the maker, the named checker and approvals.reassign_any holders). */
  'approval.requested': { proposalId: string; objectKind: string; objectId: string; action: string; makerId: string; checkerId: string };
  'approval.decided': { proposalId: string; objectKind: string; objectId: string; decision: 'APPROVED' | 'REJECTED' | 'WITHDRAWN' | 'BLOCKED' | 'VOID'; checkerId: string | null; makerId: string | null };
  'approval.checker_invalid': { proposalId: string; objectKind: string; checkerId: string; reason: 'DISABLED' | 'LOST_RIGHTS'; makerId: string };
  /** A weekly or ad-hoc exception report is ready to sign (exceptions.read holders). */
  'exception_report.ready': { reportId: string; kind: 'WEEKLY' | 'ADHOC'; periodStart: string; periodEnd: string };
}

export type RealtimeEventType = keyof RealtimePayloads;

/** Canonical envelope (docs/14 §4). */
export interface RealtimeEvent<T extends RealtimeEventType = RealtimeEventType> {
  id: string;
  type: T;
  version: number;
  occurredAt: string;
  correlationId: string;
  conversationId?: string | undefined;
  agentId?: string | undefined;
  payload: RealtimePayloads[T];
}

export type AnyRealtimeEvent = { [T in RealtimeEventType]: RealtimeEvent<T> }[RealtimeEventType];

export const REALTIME_EVENT_TYPES = [
  'interaction.received',
  'interaction.sent',
  'interaction.delivery_updated',
  'conversation.created',
  'conversation.updated',
  'conversation.control_changed',
  'conversation.resolved',
  'agent.turn_started',
  'agent.status',
  'agent.response_delta',
  'agent.turn_completed',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'tool.confirmation_requested',
  'tool.confirmation_decided',
  'handoff.requested',
  'handoff.assigned',
  'assignment.changed',
  'human.message_sent',
  'note.added',
  'ai.resumed',
  'copilot.suggestion',
  'alert.opened',
  'alert.updated',
  'alert.resolved',
  'config.changed',
  'message_template.status_changed',
  'approval.requested',
  'approval.decided',
  'approval.checker_invalid',
  'exception_report.ready',
] as const satisfies readonly RealtimeEventType[];

const KNOWN: ReadonlySet<string> = new Set(REALTIME_EVENT_TYPES);

export function isRealtimeEventType(type: string): type is RealtimeEventType {
  return KNOWN.has(type);
}

/** High-frequency, ephemeral events (never persisted) — lists usually ignore them. */
export const EPHEMERAL_TYPES: ReadonlySet<RealtimeEventType> = new Set(['agent.response_delta', 'agent.status']);

/** Narrow an event to one type. */
export function isEvent<T extends RealtimeEventType>(event: AnyRealtimeEvent, type: T): event is Extract<AnyRealtimeEvent, { type: T }> {
  return event.type === type;
}
