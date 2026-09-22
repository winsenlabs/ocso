import type { ConversationSummary } from '@/lib/api/conversations';
import type { WaitingRow } from './waiting-list';

/** Inbox summaries (GET /v1/conversations?view=waiting) → the serializable rows the live list renders. */
export function toWaitingRows(items: readonly ConversationSummary[]): WaitingRow[] {
  return items.map((c) => ({
    id: c.id,
    displayId: c.displayId,
    customerName: c.customer.name,
    agentName: c.agent.name,
    queueId: c.queue?.id ?? null,
    queueName: c.queue?.name ?? null,
    priority: c.priority,
    controlState: c.controlState,
    waitingSince: c.waitingSince,
    slaDueAt: c.slaDueAt,
    reason: c.handoff?.reason ?? null,
  }));
}
