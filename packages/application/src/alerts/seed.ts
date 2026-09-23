import { and, eq, isNull, sql } from 'drizzle-orm';
import { alertRules, notificationDestinations, uuidv7, type Db } from '@ocso/db';
import { recordAudit } from '../audit/audit.js';
import { systemActor } from '../shared/context.js';
import { recordInstalledApproval } from '../approvals/installed.js';
import { alertRuleObjectKind } from './alert-rule-approval.js';
import { createDefaultEvaluatorRegistry } from './evaluators/registry.js';
import type { AlertRuleRow } from './views.js';

type SeedRule = Pick<AlertRuleRow, 'name' | 'kind' | 'condition' | 'params' | 'windowSeconds' | 'severity' | 'audienceRoles' | 'dedupeWindowSeconds'>;

const TECH = ['TECH'];

/** Sensible defaults (docs/11 §6 technical + business examples). Thresholds are editable afterwards. */
export const DEFAULT_ALERT_RULES: readonly SeedRule[] = [
  { name: 'Healthy workers below minimum', kind: 'TECHNICAL', condition: 'workers_below_min', params: {}, windowSeconds: 60, severity: 'CRITICAL', audienceRoles: TECH, dedupeWindowSeconds: 600 },
  { name: 'Conversation queue age above 30s', kind: 'TECHNICAL', condition: 'queue_age_above', params: { topic: 'conversation.turn', thresholdSeconds: 30 }, windowSeconds: 60, severity: 'WARNING', audienceRoles: TECH, dedupeWindowSeconds: 600 },
  { name: 'Provider error rate above 5%', kind: 'TECHNICAL', condition: 'provider_error_rate_above', params: { thresholdPercent: 5, minRequests: 20 }, windowSeconds: 300, severity: 'CRITICAL', audienceRoles: TECH, dedupeWindowSeconds: 1800 },
  { name: 'MCP connection unhealthy', kind: 'TECHNICAL', condition: 'mcp_unhealthy', params: {}, windowSeconds: 300, severity: 'WARNING', audienceRoles: TECH, dedupeWindowSeconds: 1800 },
  { name: 'Time to first token p95 above 3s', kind: 'TECHNICAL', condition: 'ttft_p95_above', params: { thresholdMs: 3000, minRequests: 10 }, windowSeconds: 600, severity: 'WARNING', audienceRoles: TECH, dedupeWindowSeconds: 1800 },
  { name: 'Database degraded', kind: 'TECHNICAL', condition: 'database_degraded', params: {}, windowSeconds: 300, severity: 'CRITICAL', audienceRoles: TECH, dedupeWindowSeconds: 900 },
  { name: 'Escalation rate above 25%', kind: 'BUSINESS', condition: 'escalation_rate_above', params: { thresholdPercent: 25, minConversations: 20 }, windowSeconds: 3600, severity: 'WARNING', audienceRoles: ['HEAD', 'LEAD'], dedupeWindowSeconds: 3600 },
  { name: 'SLA breaches', kind: 'BUSINESS', condition: 'sla_breaches_above', params: { threshold: 0 }, windowSeconds: 900, severity: 'WARNING', audienceRoles: ['HEAD', 'LEAD', 'SERVICE'], dedupeWindowSeconds: 900 },
];

export const DEFAULT_IN_APP_DESTINATION = 'In-app notifications';

export interface SeedAlertRulesResult {
  destinationId: string;
  created: string[];
  existing: number;
}

/**
 * Idempotent: creates the in-app destination and any default rule not yet
 * present (matched by condition + name among platform-wide rules). Safe to run
 * on every deployment; never overwrites edits.
 */
export async function seedDefaultAlertRules(db: Db, correlationId = 'deployment-seed'): Promise<SeedAlertRulesResult> {
  const evaluators = createDefaultEvaluatorRegistry();
  const actor = systemActor('deployment-seed', correlationId, 'Deployment seed');
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ocso:seed-alert-rules'))`);
    let [destination] = await tx
      .select({ id: notificationDestinations.id })
      .from(notificationDestinations)
      .where(and(eq(notificationDestinations.kind, 'IN_APP'), eq(notificationDestinations.name, DEFAULT_IN_APP_DESTINATION)));
    if (!destination) {
      destination = { id: uuidv7() };
      await tx.insert(notificationDestinations).values({ id: destination.id, name: DEFAULT_IN_APP_DESTINATION, kind: 'IN_APP', config: {} });
      // Live from the start (enabled): recorded as installed configuration, like the rules below.
      await recordInstalledApproval(tx, { kind: 'notification_destination', id: destination.id, title: `Default destination "${DEFAULT_IN_APP_DESTINATION}"` }, 'Default in-app destination installed by OCSO, before anyone could check it');
    }
    const created: string[] = [];
    let existing = 0;
    for (const rule of DEFAULT_ALERT_RULES) {
      const [found] = await tx
        .select({ id: alertRules.id })
        .from(alertRules)
        .where(and(eq(alertRules.condition, rule.condition), eq(alertRules.name, rule.name), isNull(alertRules.agentId)));
      if (found) {
        existing += 1;
        continue;
      }
      const parsed = evaluators.find(rule.condition)?.parseParams(rule.params);
      if (!parsed?.ok) throw new Error(`default alert rule ${rule.name} has invalid params`);
      const id = uuidv7();
      await tx.insert(alertRules).values({ id, ...rule, params: parsed.params, agentId: null, destinationIds: [destination.id], autoResolve: true, enabled: true });
      // Shipped defaults are live from the start: recorded like grandfathered configuration (PM/research/11 §4).
      await recordInstalledApproval(tx, { kind: alertRuleObjectKind(rule.kind), id, title: `Default alert rule "${rule.name}"` }, 'Default alert rule installed by OCSO, before anyone could check it');
      created.push(rule.name);
    }
    if (created.length) {
      await recordAudit(tx, actor, {
        action: 'alert_rule.seed',
        targetType: 'alert_rule',
        summary: `Seeded ${created.length} default alert rule(s), recorded as installed configuration (no checker)`,
        after: { created },
      });
    }
    return { destinationId: destination.id, created, existing };
  });
}
