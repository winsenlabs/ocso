import { desc, eq, inArray, sql } from 'drizzle-orm';
import { Permission, type Principal } from '@ocso/auth';
import { forbidden, notFound, routerReferences } from '@ocso/domain';
import { channels, routerVersions, routers, type DbOrTx } from '@ocso/db';
import { parseDefinition } from './router-load.js';

/**
 * Whose router is it (PM/research/11 §4.3, ADR-026 applied to routers)? A
 * router that has ever gone live belongs to the teams its live version serves:
 * the teams of the queues it routes to and the owners of those queues' agents.
 * They alone change it (makers) and check its proposals (the proposal's
 * teamIds) — so a Lead of another team cannot re-point, stop or take the
 * channels of a router that serves someone else. A router that never went
 * live is inert: any routers.manage holder may build it, and its first
 * version's teams check its activation.
 */

/** Teams serving these queues, and the teams owning their agents. */
export async function teamsOfQueues(tx: DbOrTx, queueIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(queueIds)];
  if (!ids.length) return [];
  const list = sql.join(ids.map((q) => sql`${q}::uuid`), sql`, `);
  const rows = await tx.execute<{ team_id: string }>(sql`
    SELECT team_id FROM queue_teams WHERE queue_id IN (${list})
    UNION SELECT at.team_id FROM agent_teams at JOIN queues q ON q.agent_id = at.agent_id WHERE q.id IN (${list})`);
  return [...new Set(rows.rows.map((r) => r.team_id))].sort();
}

/**
 * The router's owning teams: those its active (live or disabled) version serves; before it has one, those
 * its newest frozen version would serve. [] = nobody in particular (platform-wide).
 */
export async function routerTeamIds(tx: DbOrTx, routerId: string): Promise<string[]> {
  const [router] = await tx.select({ activeVersionId: routers.activeVersionId }).from(routers).where(eq(routers.id, routerId));
  if (!router) return [];
  const [version] = router.activeVersionId
    ? await tx.select({ definition: routerVersions.definition }).from(routerVersions).where(eq(routerVersions.id, router.activeVersionId))
    : await tx.select({ definition: routerVersions.definition }).from(routerVersions).where(eq(routerVersions.routerId, routerId)).orderBy(desc(routerVersions.version)).limit(1);
  return version ? teamsOfQueues(tx, routerReferences(parseDefinition(version.definition)).queueIds) : [];
}

/** 403 unless the principal may change this router: it never went live, or it serves one of their teams. */
export async function assertRouterInScope(tx: DbOrTx, principal: Principal, routerId: string): Promise<void> {
  const [router] = await tx.select({ name: routers.name, activeVersionId: routers.activeVersionId }).from(routers).where(eq(routers.id, routerId));
  if (!router) throw notFound('router', routerId);
  if (!router.activeVersionId) return;
  const owners = await routerTeamIds(tx, routerId);
  if (owners.length && !owners.some((t) => principal.teamIds.includes(t))) {
    throw forbidden(Permission.ROUTERS_MANAGE, `Router ${router.name} serves other teams: only their members can change or stop it.`);
  }
}

/** Channels among these that another router routes (moving them is two steps: that router's detach, then attach). */
export async function channelsOnOtherRouters(tx: DbOrTx, routerId: string, channelIds: readonly string[]): Promise<Array<{ id: string; name: string; routerName: string }>> {
  if (!channelIds.length) return [];
  const rows = await tx
    .select({ id: channels.id, name: channels.name, routerId: channels.routerId, routerName: routers.name })
    .from(channels)
    .innerJoin(routers, eq(routers.id, channels.routerId))
    .where(inArray(channels.id, [...channelIds]));
  return rows.filter((r) => r.routerId !== routerId).map((r) => ({ id: r.id, name: r.name, routerName: r.routerName }));
}
