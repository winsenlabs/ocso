import { inArray } from 'drizzle-orm';
import { Permission, assertCan, type Principal } from '@ocso/auth';
import { channels, queues, routers, type Db } from '@ocso/db';
import { assertAgentReadable } from '../agents/access.js';
import { reachForAgents } from './reach.js';

/** One way customers reach an agent: channel → router → queue. */
export interface AgentReach {
  channel: { id: string; name: string; kind: string; status: string };
  router: { id: string; name: string };
  queue: { id: string; name: string };
}

/**
 * "Reached through" (PM/research/11 §5.7, agent Channels tab): the channels whose ACTIVE router can route to
 * a queue this agent serves — derived, never stored. Needs routers.read and read access to the agent.
 */
export async function agentReach(db: Db, principal: Principal, agentId: string): Promise<AgentReach[]> {
  assertCan(principal, Permission.ROUTERS_READ);
  await assertAgentReadable(db, principal, agentId);
  const links = await reachForAgents(db, [agentId]);
  if (!links.length) return [];
  const [channelRows, routerRows, queueRows] = await Promise.all([
    db.select({ id: channels.id, name: channels.name, kind: channels.kind, status: channels.status }).from(channels).where(inArray(channels.id, [...new Set(links.map((l) => l.channelId))])),
    db.select({ id: routers.id, name: routers.name }).from(routers).where(inArray(routers.id, [...new Set(links.map((l) => l.routerId))])),
    db.select({ id: queues.id, name: queues.name }).from(queues).where(inArray(queues.id, [...new Set(links.map((l) => l.queueId))])),
  ]);
  return links
    .flatMap((l) => {
      const [channel, router, queue] = [channelRows.find((c) => c.id === l.channelId), routerRows.find((r) => r.id === l.routerId), queueRows.find((q) => q.id === l.queueId)];
      return channel && router && queue ? [{ channel, router, queue }] : [];
    })
    .sort((a, b) => a.channel.name.localeCompare(b.channel.name) || a.queue.name.localeCompare(b.queue.name));
}
