import { eq } from 'drizzle-orm';
import { RouterDefinitionSchema, validation, type RouterDefinition } from '@ocso/domain';
import { channels, routerVersions, routers, type DbOrTx } from '@ocso/db';

export type RouterRow = typeof routers.$inferSelect;
export type RouterVersionRow = typeof routerVersions.$inferSelect;

export interface ActiveRouter {
  router: RouterRow;
  version: RouterVersionRow;
  definition: RouterDefinition;
}

/** A stored definition, validated again on the way out (stored JSON is data, not a promise). */
export function parseDefinition(raw: unknown): RouterDefinition {
  const parsed = RouterDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || 'definition'}: ${i.message}`);
    throw validation('invalid_router_definition', problems.join('; '), { problems });
  }
  return parsed.data;
}

export async function loadVersion(tx: DbOrTx, versionId: string): Promise<RouterVersionRow | null> {
  const [row] = await tx.select().from(routerVersions).where(eq(routerVersions.id, versionId));
  return row ?? null;
}

/**
 * The router a channel's customers go through: the channel's router when it
 * is ACTIVE with an active version. Null = the channel routes nowhere
 * (ingress rejects `no_router`).
 */
export async function loadActiveRouter(tx: DbOrTx, channelId: string): Promise<ActiveRouter | null> {
  const [row] = await tx
    .select({ router: routers })
    .from(channels)
    .innerJoin(routers, eq(routers.id, channels.routerId))
    .where(eq(channels.id, channelId));
  if (!row || row.router.status !== 'ACTIVE' || !row.router.activeVersionId) return null;
  return loadRouterAtVersion(tx, row.router, row.router.activeVersionId);
}

/** A router with one of its versions (the version a routing session started on). */
export async function loadRouterAtVersion(tx: DbOrTx, router: RouterRow, versionId: string): Promise<ActiveRouter | null> {
  const version = await loadVersion(tx, versionId);
  if (!version || version.routerId !== router.id) return null;
  const parsed = RouterDefinitionSchema.safeParse(version.definition);
  return parsed.success ? { router, version, definition: parsed.data } : null;
}

export async function loadRouter(tx: DbOrTx, routerId: string): Promise<RouterRow | null> {
  const [row] = await tx.select().from(routers).where(eq(routers.id, routerId));
  return row ?? null;
}
