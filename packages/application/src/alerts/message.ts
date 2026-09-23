import { eq } from 'drizzle-orm';
import { alertLink, type AlertEvent, type AlertMessage } from '@ocso/alerts';
import { alertRules, deploymentSettings, type DbOrTx } from '@ocso/db';
import type { AlertRow } from './views.js';

export interface MessageOptions {
  /** Public origin of the OCSO UI, for deep links. */
  baseUrl?: string | null | undefined;
}

/** Deployment label for external messages: "Meridian Bank · PROD". */
export async function deploymentLabel(db: DbOrTx): Promise<string | null> {
  const [row] = await db
    .select({ orgName: deploymentSettings.orgName, label: deploymentSettings.deploymentLabel })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, 1));
  return row ? `${row.orgName} · ${row.label}` : null;
}

/** Build the secret-free envelope handed to delivery adapters. */
export async function buildAlertMessage(
  db: DbOrTx,
  alert: AlertRow,
  delivery: { id: string; event: AlertEvent },
  options: MessageOptions = {},
): Promise<AlertMessage> {
  const [rule] = alert.ruleId
    ? await db.select({ name: alertRules.name, condition: alertRules.condition }).from(alertRules).where(eq(alertRules.id, alert.ruleId))
    : [];
  return {
    alertId: alert.id,
    deliveryId: delivery.id,
    event: delivery.event,
    fingerprint: alert.fingerprint,
    ruleId: alert.ruleId,
    ruleName: rule?.name ?? null,
    condition: rule?.condition ?? null,
    kind: alert.kind,
    severity: alert.severity,
    status: alert.status,
    title: alert.title,
    body: alert.body,
    value: alert.value,
    source: alert.source,
    context: alert.context,
    occurrences: alert.occurrences,
    openedAt: alert.openedAt.toISOString(),
    lastSeenAt: alert.lastSeenAt.toISOString(),
    acknowledgedAt: alert.acknowledgedAt?.toISOString() ?? null,
    resolvedAt: alert.resolvedAt?.toISOString() ?? null,
    resolution: alert.resolution,
    link: alertLink(options.baseUrl, alert.id),
    deployment: await deploymentLabel(db),
  };
}
