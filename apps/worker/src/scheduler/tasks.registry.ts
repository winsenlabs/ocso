import { randomUUID } from 'node:crypto';
import {
  createCatalogFetch,
  McpConnectionService,
  ModelCatalogService,
  relayOutboxToWebhooks,
  systemActor,
  type AlertDeliveryService,
  type AlertEngine,
  type CustomerClaimsIssuer,
  type ScalingService,
} from '@ocso/application';
import type { WorkerEnv } from '@ocso/config';
import type { Db } from '@ocso/db';
import type { QueueAdapter } from '@ocso/queue';
import type { SecretStore } from '@ocso/secrets';
import type { ScheduledTask } from './scheduler.service.js';

export interface SubsystemDeps {
  db: Db;
  env: WorkerEnv;
  secrets: SecretStore;
  queue: QueueAdapter;
  alerts: AlertEngine;
  alertDelivery: AlertDeliveryService;
  claims: CustomerClaimsIssuer;
  scaling: ScalingService;
  /** Maker–checker leader sweeps (apps/worker/src/approvals). */
  approvals: { tasks(): ScheduledTask[] };
  /** Audit store shipping, reconciliation, sealing and exports (apps/worker/src/audit, ADR-032). */
  audit: { tasks(): ScheduledTask[] };
  /** Routers: expire unanswered questions (fallback) and re-signal stalled routing (PM/research/11 §5.3). */
  routing: { sweep(correlationId: string): Promise<unknown> };
}

/**
 * Leader tasks contributed by subsystems (MCP health checks, alert
 * evaluation, metric publication). Kept separate so the core schedule stays small.
 */
export function subsystemTasks(deps: SubsystemDeps): ScheduledTask[] {
  const mcp = new McpConnectionService({ db: deps.db, secrets: deps.secrets, publicUrl: deps.env.OCSO_PUBLIC_URL });
  return [
    // Also purges expired OAuth sign-ins; per-connection intervals are honoured inside.
    { name: 'mcp-health-checks', everySeconds: 10, run: () => mcp.runDueHealthChecks() },
    { name: 'alert-evaluation', everySeconds: 30, run: () => deps.alerts.evaluate() },
    // Deliveries whose publish failed (crash between commit and publish) are re-queued.
    { name: 'alert-redispatch', everySeconds: 120, run: () => deps.alertDelivery.redispatchPending(deps.queue) },
    { name: 'retire-signing-keys', everySeconds: 3600, run: () => deps.claims.retireExpired() },
    { name: 'webhook-relay', everySeconds: 2, run: () => relayOutboxToWebhooks(deps.db, deps.queue) },
    // Worker scaling (ADR-023): CloudWatch signals each minute (ECS only); settings are
    // reconciled every 5 min here and immediately on config.changed (lifecycle service).
    ...(deps.scaling.publishesMetrics ? [{ name: 'scaling-metrics', everySeconds: 60, run: () => deps.scaling.publishMetrics() }] : []),
    { name: 'scaling-reconcile', everySeconds: 300, run: () => deps.scaling.reconcile('periodic') },
    // Model catalog (ADR-027): hourly check, downloads when a source is a day old (an hour after a failure).
    ...(deps.env.OCSO_MODEL_CATALOG_REFRESH ? [{ name: 'model-catalog-refresh', everySeconds: 3600, run: () => refreshModelCatalog(deps.db) }] : []),
    // Maker–checker: checker validity (flags, never reassigns), notice/activation redispatch, orphan voiding.
    ...deps.approvals.tasks(),
    ...deps.audit.tasks(),
    { name: 'routing-timeout', everySeconds: 60, run: ({ correlationId }) => deps.routing.sweep(correlationId) },
  ];
}

/** One SSRF-guarded, allowlisted fetch per run; catalog-origin prices follow the refresh (audited as a system change). */
async function refreshModelCatalog(db: Db) {
  const egress = createCatalogFetch();
  try {
    return await new ModelCatalogService({ db, fetch: egress.fetch }).refreshIfStale(systemActor('model-catalog', randomUUID(), 'Model catalog refresh'));
  } finally {
    egress.close();
  }
}
