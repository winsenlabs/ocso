import { queues, uuidv7, type Db } from '@ocso/db';
import { routeChannelToAgent, systemActor } from '@ocso/application';

/**
 * channel → pass-through router → queue (with the agent) — what `defaultAgentId`
 * on a channel used to do (PM/research/11 §5). Router activation is an approval
 * over HTTP, so tests make the router live through the application function.
 */
export async function routeChannel(h: { db: { db: Db } }, channelId: string, agentId: string, queueId?: string): Promise<{ routerId: string; queueId: string }> {
  let queue = queueId;
  if (!queue) {
    queue = uuidv7();
    await h.db.db.insert(queues).values({ id: queue, name: `Service ${queue.slice(-6)}` });
  }
  const { routerId } = await routeChannelToAgent(h.db.db, systemActor('test-routing', 'test'), { channelId, agentId, queueId: queue, name: `Router ${channelId.slice(-6)}` });
  return { routerId, queueId: queue };
}
