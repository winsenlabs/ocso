import type { ControlState, DeliveryStatus, HandoffMode, HandoffTrigger, Priority } from '@ocso/domain';

/**
 * Versioned internal event catalogue (docs/archive/specs/02 §8, docs/archive/specs/14 §3).
 * Payloads carry ids and small facts; subscribers load details through
 * authorized services. Never put secrets or message content here.
 */
export interface OcsoEventPayloads {
  'interaction.received': { interactionId: string; seq: number; actorType: string; channelId: string | null };
  'interaction.sent': { interactionId: string; seq: number; actorType: 'AGENT' | 'HUMAN' | 'ROUTER' };
  'interaction.delivery_updated': { interactionId: string; status: DeliveryStatus; errorCode?: string };
  'conversation.created': { customerId: string; channelId: string | null; queueId: string | null };
  'conversation.updated': { fields: string[] };
  'conversation.control_changed': {
    from: ControlState;
    to: ControlState;
    command: string;
    actorType: string;
    actorId: string | null;
  };
  'conversation.assigned_worker': { workerId: string; leaseVersion: number };
  'conversation.resolved': { disposition: string | null; resolvedBy: string | null };
  'agent.turn_started': { turnId: string; workerId: string };
  'agent.status': { turnId: string; status: 'THINKING' | 'CALLING_TOOL' | 'WRITING' | 'WAITING_CONFIRMATION' };
  /** Ephemeral (NOTIFY only, never persisted): streamed text delta. */
  'agent.response_delta': { turnId: string; interactionId: string; delta: string };
  'agent.turn_completed': { turnId: string; outcome: 'REPLIED' | 'HANDOFF' | 'NO_REPLY' | 'FAILED' | 'CANCELLED' };
  'model.request_started': { turnId: string | null; profileId: string; providerId: string; model: string };
  'model.request_completed': { usageEventId: string; status: 'OK' | 'ERROR' };
  'model.fallback': { turnId: string | null; profileId: string; fromProviderId: string; toProviderId: string; reason: string };
  'tool.started': { toolCallId: string; toolName: string; connectionId: string | null };
  'tool.completed': { toolCallId: string; toolName: string; latencyMs: number };
  'tool.failed': { toolCallId: string; toolName: string; errorCategory: string };
  'tool.confirmation_requested': { toolCallId: string; toolName: string };
  'tool.confirmation_decided': { toolCallId: string; decision: 'APPROVED' | 'DENIED' | 'EXPIRED'; userId: string | null };
  'handoff.requested': { handoffId: string; trigger: HandoffTrigger; reason: string; priority: Priority };
  'handoff.assigned': { handoffId: string; mode: HandoffMode; queueId: string; userId: string | null };
  'assignment.changed': { userId: string | null; previousUserId: string | null; kind: string };
  'human.message_sent': { interactionId: string; userId: string };
  'note.added': { noteId: string; userId: string };
  'ai.resumed': { handoffId: string | null };
  'copilot.suggestion': { suggestionId: string };
  'alert.opened': { alertId: string; severity: string; kind: 'TECHNICAL' | 'BUSINESS' };
  'alert.updated': { alertId: string; status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' };
  'alert.resolved': { alertId: string };
  'config.changed': { area: string; entityId: string | null };
  /** A message template's review result changed (poller or provider webhook); `submittedBy` gets an in-app notice. */
  'message_template.status_changed': {
    templateId: string;
    channelId: string;
    name: string;
    language: string;
    status: string;
    previousStatus: string;
    submittedBy: string | null;
  };
  'cache.invalidated': { scope: string; key: string | null; reason: string };
  'worker.heartbeat': { workerId: string; activeLeases: number; capacity: number };
  /** Maker–checker (PM/research/11b): delivered to the maker, the named checker and approvals.reassign_any holders. */
  'approval.requested': { proposalId: string; objectKind: string; objectId: string; action: string; makerId: string; checkerId: string };
  'approval.decided': {
    proposalId: string;
    objectKind: string;
    objectId: string;
    decision: 'APPROVED' | 'REJECTED' | 'WITHDRAWN' | 'BLOCKED' | 'VOID';
    checkerId: string | null;
    makerId: string | null;
  };
  'approval.checker_invalid': { proposalId: string; objectKind: string; checkerId: string; reason: 'DISABLED' | 'LOST_RIGHTS'; makerId: string };
  /** Routing (PM/research/11 §5.3): a router chose the queue and agent; or a conversation moved to another queue. */
  'conversation.routed': {
    routerId: string | null;
    /** The router version that decided (null for transfers). */
    routerVersionId?: string | null;
    queueId: string;
    agentId: string;
    outcome: 'RULE' | 'MODEL' | 'FALLBACK' | 'PASS_THROUGH' | 'CONTINUE' | 'TIMEOUT' | 'TRANSFER';
    ruleIndex: number | null;
  };
  /** Exceptions (PM/research/11 §7): a weekly or ad-hoc exception report was frozen and awaits a signature (exceptions.read holders). */
  'exception_report.ready': { reportId: string; kind: 'WEEKLY' | 'ADHOC'; periodStart: string; periodEnd: string };
}

export type OcsoEventType = keyof OcsoEventPayloads;

/** Events that are never written to the outbox (high-frequency, ephemeral). */
export const EPHEMERAL_EVENT_TYPES: ReadonlySet<OcsoEventType> = new Set([
  'agent.response_delta',
  'agent.status',
  'worker.heartbeat',
]);
