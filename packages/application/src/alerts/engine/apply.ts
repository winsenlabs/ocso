import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { withinDedupeWindow, type AlertKind, type AlertSeverity } from '@ocso/alerts';
import { alerts, uuidv7, type DbOrTx } from '@ocso/db';
import { emitEvent } from '../../events/outbox.js';
import type { ActorContext } from '../../shared/context.js';
import { createDeliveries, type PendingDelivery } from '../dispatch.js';
import type { AlertEvaluator, Observation } from '../evaluators/contract.js';
import { markResolved } from '../lifecycle.js';
import type { AlertRow, AlertRuleRow } from '../views.js';

export interface RuleOutcome {
  opened: Array<{ id: string; kind: AlertKind; severity: AlertSeverity }>;
  updated: number;
  resolved: number;
  suppressed: number;
  deliveries: PendingDelivery[];
}

/**
 * Apply one rule's observations to the alert lifecycle, inside a transaction
 * serialized per rule:
 * - firing + unresolved alert with the fingerprint → bump occurrences / lastSeenAt
 * - firing + resolved within dedupeWindowSeconds → suppressed (no reopen)
 * - firing otherwise → open a new alert, OPENED deliveries, `alert.opened`
 * - unresolved alert whose fingerprint is not firing + autoResolve → resolve
 */
export async function applyObservations(
  tx: DbOrTx,
  actor: ActorContext,
  rule: AlertRuleRow,
  evaluator: Pick<AlertEvaluator, 'condition' | 'method'>,
  observations: readonly Observation[],
  now: Date,
): Promise<RuleOutcome> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`alert-rule:${rule.id}`}))`);
  const outcome: RuleOutcome = { opened: [], updated: 0, resolved: 0, suppressed: 0, deliveries: [] };
  const unresolved = await tx.select().from(alerts).where(and(eq(alerts.ruleId, rule.id), ne(alerts.status, 'RESOLVED')));
  const byFingerprint = new Map(unresolved.map((a) => [a.fingerprint, a]));
  const firing = new Map(observations.filter((o) => o.firing).map((o) => [o.fingerprint, o]));

  for (const obs of firing.values()) {
    const context: Record<string, unknown> = { ...obs.context, condition: evaluator.condition, method: evaluator.method };
    const existing = byFingerprint.get(obs.fingerprint);
    if (existing) {
      await bump(tx, rule, existing, obs, context, now);
      outcome.updated += 1;
      continue;
    }
    if (await recentlyResolved(tx, obs.fingerprint, now, rule.dedupeWindowSeconds)) {
      outcome.suppressed += 1;
      continue;
    }
    const id = uuidv7();
    const inserted = await tx
      .insert(alerts)
      .values({
        id,
        ruleId: rule.id,
        fingerprint: obs.fingerprint,
        kind: rule.kind,
        severity: rule.severity,
        status: 'OPEN',
        title: obs.title,
        body: obs.body,
        value: obs.value,
        source: obs.source,
        audienceRoles: rule.audienceRoles,
        context,
        occurrences: 1,
        openedAt: now,
        lastSeenAt: now,
      })
      .onConflictDoNothing({ target: alerts.fingerprint, where: sql`status <> 'RESOLVED'` })
      .returning({ id: alerts.id });
    if (!inserted.length) continue;
    outcome.opened.push({ id, kind: rule.kind, severity: rule.severity });
    outcome.deliveries.push(...(await createDeliveries(tx, id, rule.destinationIds, 'OPENED', now)));
    const agentId = typeof context['agentId'] === 'string' ? context['agentId'] : null;
    await emitEvent(tx, actor, 'alert.opened', { alertId: id, severity: rule.severity, kind: rule.kind }, { agentId });
  }

  if (rule.autoResolve) {
    for (const alert of unresolved) {
      if (firing.has(alert.fingerprint)) continue;
      const deliveries = await markResolved(tx, actor, alert, {
        now,
        resolvedBy: null,
        resolution: 'Auto-resolved: condition no longer met',
        destinationIds: rule.destinationIds,
        auditAction: 'alert.auto_resolve',
        auditSummary: `Auto-resolved alert: ${alert.title}`,
      });
      outcome.deliveries.push(...deliveries);
      outcome.resolved += 1;
    }
  }
  return outcome;
}

async function bump(tx: DbOrTx, rule: AlertRuleRow, alert: AlertRow, obs: Observation, context: Record<string, unknown>, now: Date): Promise<void> {
  await tx
    .update(alerts)
    .set({
      occurrences: sql`${alerts.occurrences} + 1`,
      lastSeenAt: now,
      title: obs.title,
      body: obs.body,
      value: obs.value,
      source: obs.source,
      context,
      severity: rule.severity,
      audienceRoles: rule.audienceRoles,
    })
    .where(eq(alerts.id, alert.id));
}

async function recentlyResolved(tx: DbOrTx, fingerprint: string, now: Date, dedupeWindowSeconds: number): Promise<boolean> {
  if (dedupeWindowSeconds <= 0) return false;
  const [last] = await tx
    .select({ resolvedAt: alerts.resolvedAt })
    .from(alerts)
    .where(and(eq(alerts.fingerprint, fingerprint), eq(alerts.status, 'RESOLVED')))
    .orderBy(desc(alerts.resolvedAt))
    .limit(1);
  return withinDedupeWindow(last?.resolvedAt ?? null, now, dedupeWindowSeconds);
}
