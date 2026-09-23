import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { databaseUrl } from './config';

/**
 * Routing fixtures for the e2e stack (PM/research/11 §5). A channel reaches an
 * agent through a router and a queue; making a router live is a maker–checker
 * approval over HTTP, so specs do that step in SQL on their throwaway database
 * (the same rows RouterService.activateVersion and attachChannels write).
 */
function psql(statement: string): void {
  execFileSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-qc', statement], { stdio: 'pipe', env: { ...process.env, PGOPTIONS: '-c client_min_messages=warning' } });
}

const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** The queue's one AI agent (only when it has none yet). */
export function giveQueueAgent(queueId: string, agentId: string): void {
  psql(`UPDATE queues SET agent_id = ${lit(agentId)} WHERE id = ${lit(queueId)} AND agent_id IS NULL`);
}

/** Activate a router version (created over HTTP) and point channels at the router. */
export function activateRouter(routerId: string, versionId: string, channelIds: readonly string[]): void {
  psql(
    [
      `UPDATE routers SET status = 'ACTIVE', active_version_id = ${lit(versionId)}, updated_at = now() WHERE id = ${lit(routerId)}`,
      ...channelIds.map((c) => `UPDATE channels SET router_id = ${lit(routerId)}, updated_at = now() WHERE id = ${lit(c)}`),
    ].join('; '),
  );
}

/** channel → pass-through router → queue with the agent: what a channel's default agent used to do. */
export function routeChannelToAgent(input: { channelId: string; agentId: string; queueId: string; name: string }): void {
  giveQueueAgent(input.queueId, input.agentId);
  const [routerId, versionId] = [randomUUID(), randomUUID()];
  const definition = JSON.stringify({ steps: [], rules: [], fallbackQueueId: input.queueId, returning: null, timeoutMinutes: 10 });
  psql(
    [
      `INSERT INTO routers (id, name, description, status, active_version_id) VALUES (${lit(routerId)}, ${lit(input.name)}, 'e2e pass-through', 'ACTIVE', ${lit(versionId)})`,
      `INSERT INTO router_versions (id, router_id, version, definition, reason) VALUES (${lit(versionId)}, ${lit(routerId)}, 1, ${lit(definition)}::jsonb, 'e2e')`,
      `INSERT INTO router_drafts (router_id, definition) VALUES (${lit(routerId)}, ${lit(definition)}::jsonb)`,
      `UPDATE channels SET router_id = ${lit(routerId)} WHERE id = ${lit(input.channelId)}`,
    ].join('; '),
  );
}
