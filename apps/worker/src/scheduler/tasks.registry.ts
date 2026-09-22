import { McpConnectionService, type AlertDeliveryService, type AlertEngine, type CustomerClaimsIssuer } from '@ocso/application';
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
  ];
}
