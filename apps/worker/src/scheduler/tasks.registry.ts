import { McpConnectionService } from '@ocso/application';
import type { WorkerEnv } from '@ocso/config';
import type { Db } from '@ocso/db';
import type { SecretStore } from '@ocso/secrets';
import type { ScheduledTask } from './scheduler.service.js';

export interface SubsystemDeps {
  db: Db;
  env: WorkerEnv;
  secrets: SecretStore;
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
  ];
}
