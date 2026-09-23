import { eq, max } from 'drizzle-orm';
import { notFound } from '@ocso/domain';
import { routerDrafts, routerVersions, routers, uuidv7, type DbOrTx } from '@ocso/db';
import { lockObject } from '../approvals/guard.js';
import { recordAudit } from '../audit/audit.js';
import type { ActorContext } from '../shared/context.js';
import { parseDefinition, type RouterRow } from './router-load.js';

/** Router writes shared by the service, the approval activation and the trusted seed path. */

/** The approval key, then the router row (every writer of a router's configuration). */
export async function lockRouter(tx: DbOrTx, id: string): Promise<RouterRow> {
  await lockObject(tx, `router:${id}`);
  const [row] = await tx.select().from(routers).where(eq(routers.id, id)).for('update');
  if (!row) throw notFound('router', id);
  return row;
}

/** Freeze a router's draft into version n+1 (structurally valid by construction; references checked at activation). */
export async function freezeRouterDraft(tx: DbOrTx, actor: ActorContext, routerId: string, reason: string): Promise<{ id: string; version: number }> {
  const [router] = await tx.select().from(routers).where(eq(routers.id, routerId)).for('update');
  if (!router) throw notFound('router', routerId);
  const [draft] = await tx.select().from(routerDrafts).where(eq(routerDrafts.routerId, routerId));
  if (!draft) throw notFound('router_draft', routerId);
  const definition = parseDefinition(draft.definition);
  const [last] = await tx.select({ v: max(routerVersions.version) }).from(routerVersions).where(eq(routerVersions.routerId, routerId));
  const version = (last?.v ?? 0) + 1;
  const id = uuidv7();
  await tx.insert(routerVersions).values({ id, routerId, version, definition, reason, createdBy: actor.principal?.userId ?? null });
  await recordAudit(tx, actor, { action: 'router.version_create', targetType: 'router', targetId: routerId, summary: `Router ${router.name}: version ${version}${reason ? ` — ${reason}` : ''}`, after: { versionId: id, version, definition } });
  return { id, version };
}
