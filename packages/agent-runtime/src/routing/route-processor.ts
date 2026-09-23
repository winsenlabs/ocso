import { eq } from 'drizzle-orm';
import type { SessionWindowHours, RoutingEngine } from '@ocso/application';
import type { ChannelRegistry } from '@ocso/channels';
import { conversations, type Db } from '@ocso/db';
import { isDomainError } from '@ocso/domain';
import type { Logger } from '@ocso/observability';
import type { HandlerResult, QueueMessage } from '@ocso/queue';

/**
 * `conversation.route` handler (PM/research/11 §5.3). Only ROUTING
 * conversations are advanced. Concurrency is safe without the turn lease:
 * every engine step locks the conversation and its routing row, and a model
 * result is applied only if the session did not move meanwhile — so a route
 * job never fences an AI turn that runs on the same conversation.
 */
export class RouteProcessor {
  constructor(private readonly deps: { db: Db; engine: RoutingEngine; logger: Logger }) {}

  async handle(message: QueueMessage<{ conversationId: string }>): Promise<HandlerResult> {
    const { conversationId } = message.payload;
    const [conv] = await this.deps.db.select({ state: conversations.controlState }).from(conversations).where(eq(conversations.id, conversationId));
    if (conv?.state !== 'ROUTING') return { kind: 'ack' };
    try {
      await this.deps.engine.advance(conversationId, message.id);
      return { kind: 'ack' };
    } catch (err) {
      this.deps.logger.error({ err, conversationId }, 'routing failed');
      const retriable = isDomainError(err) ? err.retriable || err.category === 'conflict' : true;
      return retriable ? { kind: 'retry', delaySeconds: Math.min(60, 2 ** message.attempt), reason: (err as Error).message } : { kind: 'dead', reason: (err as Error).message };
    }
  }
}

/** The channel adapter's declared session window, for router messages outside it (templates). */
export function sessionWindowHoursFrom(registry: ChannelRegistry): SessionWindowHours {
  return (channel) => {
    if (!registry.has(channel.kind)) return null;
    return registry.get(channel.kind).capabilities({ id: channel.id, kind: channel.kind, name: channel.name, settings: channel.settings, secrets: {} }).sessionWindowHours;
  };
}
