import { and, desc, eq, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { ALERT_KINDS, ALERT_SEVERITIES, ALERT_STATUSES, type AlertKind, type AlertSeverity } from '@ocso/alerts';
import { Permission, assertCan } from '@ocso/auth';
import { alertDeliveries, alertRules, alerts, notificationDestinations, type Db, type DbOrTx } from '@ocso/db';
import { conflict, forbidden, notFound, validation } from '@ocso/domain';
import type { QueueAdapter } from '@ocso/queue';
import { z } from 'zod';
import { nowOf, type ActorContext } from '../shared/context.js';
import { canSeeAlert, readableKinds, requirePrincipal, visibleAlertsWhere } from './audience.js';
import { publishDeliveries, type PendingDelivery } from './dispatch.js';
import { markAcknowledged, markResolved } from './lifecycle.js';
import { toAlertView, type AlertDetailView, type AlertRow, type AlertView } from './views.js';

export const AlertListQuery = z.object({
  /** UNRESOLVED = OPEN or ACKNOWLEDGED. */
  status: z.enum([...ALERT_STATUSES, 'UNRESOLVED']).optional(),
  kind: z.enum(ALERT_KINDS).optional(),
  severity: z.enum(ALERT_SEVERITIES).optional(),
  agentId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Opaque keyset cursor from the previous page. */
  cursor: z.string().max(200).optional(),
});
export type AlertListQuery = z.input<typeof AlertListQuery>;

export const AcknowledgeAlertInput = z.object({ note: z.string().trim().min(1).max(2000).optional() }).default({});
export type AcknowledgeAlertInput = z.infer<typeof AcknowledgeAlertInput>;

export const ResolveAlertInput = z.object({ note: z.string().trim().min(1).max(2000) });
export type ResolveAlertInput = z.infer<typeof ResolveAlertInput>;

export interface AlertPage {
  items: AlertView[];
  nextCursor: string | null;
}

/** Nav-badge counts over unresolved alerts the principal can see. */
export interface AlertCounts {
  unresolved: number;
  open: number;
  acknowledged: number;
  bySeverity: Record<AlertSeverity, number>;
  byKind: Partial<Record<AlertKind, number>>;
}

/**
 * Alert inbox (docs/11 §6). A user sees an alert only when their role is in
 * its audience AND they hold the read permission for its kind. Alerts the
 * user cannot see are reported as not found.
 */
export class AlertService {
  constructor(
    private readonly db: Db,
    private readonly queue: QueueAdapter,
    private readonly deps: { now?: (() => Date) | undefined } = {},
  ) {}

  async list(actor: ActorContext, query: AlertListQuery = {}): Promise<AlertPage> {
    const q = AlertListQuery.parse(query);
    const principal = requirePrincipal(actor, 'alerts.read');
    const kinds = readableKinds(principal);
    if (!kinds.length) throw forbidden('alerts.read', `role ${principal.role} cannot read alerts`);
    if (q.kind && !kinds.includes(q.kind)) throw forbidden('alerts.read', `cannot read ${q.kind.toLowerCase()} alerts`);
    const where: SQL[] = [visibleAlertsWhere(principal, q.kind ? [q.kind] : kinds)];
    if (q.status === 'UNRESOLVED') where.push(ne(alerts.status, 'RESOLVED'));
    else if (q.status) where.push(eq(alerts.status, q.status));
    if (q.severity) where.push(eq(alerts.severity, q.severity));
    if (q.agentId) where.push(sql`${alerts.context}->>'agentId' = ${q.agentId}`);
    if (q.cursor) where.push(afterCursor(q.cursor));
    const rows = await this.db
      .select({ alert: alerts, ruleName: alertRules.name, condition: alertRules.condition })
      .from(alerts)
      .leftJoin(alertRules, eq(alertRules.id, alerts.ruleId))
      .where(and(...where))
      .orderBy(desc(alerts.openedAt), desc(alerts.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => toAlertView(r.alert, { name: r.ruleName, condition: r.condition })),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.alert) : null,
    };
  }

  async get(actor: ActorContext, id: string): Promise<AlertDetailView> {
    const alert = await this.loadVisible(this.db, actor, id);
    const [rule] = alert.ruleId ? await this.db.select().from(alertRules).where(eq(alertRules.id, alert.ruleId)) : [];
    const deliveries = await this.db
      .select({ d: alertDeliveries, name: notificationDestinations.name, kind: notificationDestinations.kind })
      .from(alertDeliveries)
      .leftJoin(notificationDestinations, eq(notificationDestinations.id, alertDeliveries.destinationId))
      .where(eq(alertDeliveries.alertId, id))
      .orderBy(alertDeliveries.createdAt);
    return {
      ...toAlertView(alert, rule ? { name: rule.name, condition: rule.condition } : null),
      deliveries: deliveries.map(({ d, name, kind }) => ({
        id: d.id,
        destinationId: d.destinationId,
        destinationName: name,
        destinationKind: kind,
        event: d.event,
        status: d.status,
        attempts: d.attempts,
        lastError: d.lastError,
        createdAt: d.createdAt.toISOString(),
        sentAt: d.sentAt?.toISOString() ?? null,
      })),
    };
  }

  async counts(actor: ActorContext, filter: { agentId?: string | undefined } = {}): Promise<AlertCounts> {
    const principal = requirePrincipal(actor, 'alerts.read');
    const where: SQL[] = [visibleAlertsWhere(principal), ne(alerts.status, 'RESOLVED')];
    if (filter.agentId) where.push(sql`${alerts.context}->>'agentId' = ${filter.agentId}`);
    const rows = await this.db
      .select({ status: alerts.status, severity: alerts.severity, kind: alerts.kind, n: sql<number>`count(*)::int` })
      .from(alerts)
      .where(and(...where))
      .groupBy(alerts.status, alerts.severity, alerts.kind);
    const counts: AlertCounts = { unresolved: 0, open: 0, acknowledged: 0, bySeverity: { INFO: 0, WARNING: 0, CRITICAL: 0 }, byKind: {} };
    for (const kind of readableKinds(principal)) counts.byKind[kind] = 0;
    for (const r of rows) {
      counts.unresolved += r.n;
      if (r.status === 'OPEN') counts.open += r.n;
      if (r.status === 'ACKNOWLEDGED') counts.acknowledged += r.n;
      counts.bySeverity[r.severity] += r.n;
      counts.byKind[r.kind] = (counts.byKind[r.kind] ?? 0) + r.n;
    }
    return counts;
  }

  async acknowledge(actor: ActorContext, id: string, input: AcknowledgeAlertInput = {}): Promise<AlertView> {
    const principal = requirePrincipal(actor, Permission.ALERTS_ACKNOWLEDGE);
    assertCan(principal, Permission.ALERTS_ACKNOWLEDGE);
    const now = nowOf(this.deps);
    const pending = await this.db.transaction(async (tx) => {
      const alert = await this.loadVisible(tx, actor, id, true);
      if (alert.status === 'RESOLVED') throw conflict('alert_resolved', 'The alert is already resolved');
      if (alert.status === 'ACKNOWLEDGED') return [] as PendingDelivery[];
      return markAcknowledged(tx, actor, alert, { now, userId: principal.userId, note: input.note ?? null, destinationIds: await ruleDestinations(tx, alert) });
    });
    await publishDeliveries(this.queue, pending);
    return this.get(actor, id);
  }

  async resolve(actor: ActorContext, id: string, input: ResolveAlertInput): Promise<AlertView> {
    const principal = requirePrincipal(actor, Permission.ALERTS_ACKNOWLEDGE);
    assertCan(principal, Permission.ALERTS_ACKNOWLEDGE);
    if (!input.note?.trim()) throw validation('resolution_note_required', 'A resolution note is required');
    const now = nowOf(this.deps);
    const pending = await this.db.transaction(async (tx) => {
      const alert = await this.loadVisible(tx, actor, id, true);
      if (alert.status === 'RESOLVED') throw conflict('alert_resolved', 'The alert is already resolved');
      return markResolved(tx, actor, alert, {
        now,
        resolvedBy: principal.userId,
        resolution: input.note.trim(),
        destinationIds: await ruleDestinations(tx, alert),
        auditAction: 'alert.resolve',
        auditSummary: `Resolved alert: ${alert.title}`,
      });
    });
    await publishDeliveries(this.queue, pending);
    return this.get(actor, id);
  }

  private async loadVisible(db: DbOrTx, actor: ActorContext, id: string, forUpdate = false): Promise<AlertRow> {
    const principal = requirePrincipal(actor, 'alerts.read');
    const query = db.select().from(alerts).where(eq(alerts.id, id));
    const [row] = forUpdate ? await query.for('update') : await query;
    if (!row || !canSeeAlert(principal, row)) throw notFound('alert', id);
    return row;
  }
}

async function ruleDestinations(db: DbOrTx, alert: AlertRow): Promise<string[]> {
  if (!alert.ruleId) return [];
  const [rule] = await db.select({ ids: alertRules.destinationIds }).from(alertRules).where(eq(alertRules.id, alert.ruleId));
  return rule?.ids ?? [];
}

function encodeCursor(alert: AlertRow): string {
  return Buffer.from(`${alert.openedAt.toISOString()}|${alert.id}`).toString('base64url');
}

function afterCursor(cursor: string): SQL {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const date = at ? new Date(at) : null;
  if (!date || Number.isNaN(date.getTime()) || !id || !z.uuid().safeParse(id).success) throw validation('invalid_cursor', 'Invalid cursor');
  return or(lt(alerts.openedAt, date), and(eq(alerts.openedAt, date), lt(alerts.id, id)))!;
}
