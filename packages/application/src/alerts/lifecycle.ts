import { eq } from 'drizzle-orm';
import type { DestinationEventRouting } from '@ocso/alerts';
import { alerts, type DbOrTx } from '@ocso/db';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { createDeliveries, type PendingDelivery } from './dispatch.js';
import type { AlertRow } from './views.js';

/** Agent the alert concerns (routes realtime events to agent-scoped views). */
export function alertAgentId(alert: Pick<AlertRow, 'context'>): string | null {
  const id = alert.context['agentId'];
  return typeof id === 'string' ? id : null;
}

export interface ResolveOptions {
  now: Date;
  resolvedBy: string | null;
  resolution: string;
  destinationIds: readonly string[];
  /** Which destination kinds receive the RESOLVED event (the delivery registry). */
  routing: DestinationEventRouting;
  auditAction: 'alert.resolve' | 'alert.auto_resolve' | 'alert.rule_deleted';
  auditSummary: string;
}

/** OPEN|ACKNOWLEDGED → RESOLVED with audit, events and RESOLVED deliveries (caller publishes). */
export async function markResolved(tx: DbOrTx, actor: ActorContext, alert: AlertRow, o: ResolveOptions): Promise<PendingDelivery[]> {
  await tx
    .update(alerts)
    .set({ status: 'RESOLVED', resolvedAt: o.now, resolvedBy: o.resolvedBy, resolution: o.resolution })
    .where(eq(alerts.id, alert.id));
  await recordAudit(tx, actor, {
    action: o.auditAction,
    targetType: 'alert',
    targetId: alert.id,
    summary: o.auditSummary,
    before: { status: alert.status },
    after: { status: 'RESOLVED', resolution: o.resolution },
  });
  const agentId = alertAgentId(alert);
  await emitEvent(tx, actor, 'alert.updated', { alertId: alert.id, status: 'RESOLVED' }, { agentId });
  await emitEvent(tx, actor, 'alert.resolved', { alertId: alert.id }, { agentId });
  return createDeliveries(tx, o.routing, alert.id, o.destinationIds, 'RESOLVED', o.now);
}

export interface AcknowledgeOptions {
  now: Date;
  userId: string;
  note: string | null;
  destinationIds: readonly string[];
  routing: DestinationEventRouting;
}

/** OPEN → ACKNOWLEDGED with audit, event and ACKNOWLEDGED deliveries (caller publishes). */
export async function markAcknowledged(tx: DbOrTx, actor: ActorContext, alert: AlertRow, o: AcknowledgeOptions): Promise<PendingDelivery[]> {
  await tx.update(alerts).set({ status: 'ACKNOWLEDGED', acknowledgedAt: o.now, acknowledgedBy: o.userId }).where(eq(alerts.id, alert.id));
  await recordAudit(tx, actor, {
    action: 'alert.acknowledge',
    targetType: 'alert',
    targetId: alert.id,
    summary: `Acknowledged alert: ${alert.title}`,
    before: { status: alert.status },
    after: { status: 'ACKNOWLEDGED', ...(o.note ? { note: o.note } : {}) },
  });
  await emitEvent(tx, actor, 'alert.updated', { alertId: alert.id, status: 'ACKNOWLEDGED' }, { agentId: alertAgentId(alert) });
  return createDeliveries(tx, o.routing, alert.id, o.destinationIds, 'ACKNOWLEDGED', o.now);
}
