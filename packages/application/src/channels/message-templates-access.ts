import { and, eq, sql } from 'drizzle-orm';
import { Permission, assertCan, can, type Principal } from '@ocso/auth';
import { notFound } from '@ocso/domain';
import { channels, type DbOrTx } from '@ocso/db';
import { agentsOwnedBy } from '../agents/access.js';
import { channelsReachingAgents } from '../routing/reach.js';

export type ChannelRow = typeof channels.$inferSelect;

/**
 * Who may manage a channel's message templates (docs/09 §6): templates are
 * business content, so `message_templates.manage` (Lead, Tech admin).
 * A Tech admin (channels.manage) manages every channel; a Lead only
 * channels that reach a virtual agent one of their teams owns (through the
 * channel's active router and a queue that agent serves). Out of scope is
 * reported as not found so other teams' channels do not leak.
 */
export function manageableChannelsSql(principal: Principal) {
  if (can(principal, Permission.CHANNELS_MANAGE)) return null;
  const owned = agentsOwnedBy(principal.teamIds);
  return sql`${channels.id} IN (${channelsReachingAgents(owned)})`;
}

export async function loadManageableChannel(db: DbOrTx, principal: Principal, channelId: string): Promise<ChannelRow> {
  assertCan(principal, Permission.MESSAGE_TEMPLATES_MANAGE);
  const scope = manageableChannelsSql(principal);
  const [row] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), scope ?? undefined));
  if (!row) throw notFound('channel', channelId);
  return row;
}

export async function loadChannel(db: DbOrTx, channelId: string): Promise<ChannelRow> {
  const [row] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!row) throw notFound('channel', channelId);
  return row;
}
