import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { customerSafeParts, type ChannelCapabilities } from '@ocso/channels';
import type { InteractionPart } from '@ocso/domain';
import { interactionParts, interactions, users, type Db } from '@ocso/db';
import { DB } from '../../infrastructure/tokens.js';
import { ConversationAccessService } from '../conversations/conversation-access.service.js';

export interface WebChatMessage {
  id: string;
  seq: number;
  from: 'customer' | 'agent' | 'human';
  name: string | null;
  parts: Array<InteractionPart & { url?: string }>;
  deliveryStatus: string;
  at: string;
}

/**
 * Customer-facing message view: only customer-visible MESSAGE interactions and
 * only parts the web-chat channel may render (docs/07 §5). Internal events,
 * notes and tool traces never leave this function.
 */
@Injectable()
export class WebChatMessagesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ConversationAccessService) private readonly media: ConversationAccessService,
  ) {}

  async list(conversationId: string, capabilities: ChannelCapabilities, afterSeq = 0, agentName: string | null = null): Promise<WebChatMessage[]> {
    const rows = await this.db
      .select()
      .from(interactions)
      .where(and(eq(interactions.conversationId, conversationId), eq(interactions.visibility, 'CUSTOMER'), eq(interactions.kind, 'MESSAGE'), gt(interactions.seq, afterSeq)))
      .orderBy(asc(interactions.seq))
      .limit(200);
    return this.render(rows, capabilities, agentName);
  }

  async one(interactionId: string, capabilities: ChannelCapabilities, agentName: string | null): Promise<WebChatMessage | null> {
    const rows = await this.db.select().from(interactions).where(and(eq(interactions.id, interactionId), eq(interactions.visibility, 'CUSTOMER'), eq(interactions.kind, 'MESSAGE')));
    return (await this.render(rows, capabilities, agentName))[0] ?? null;
  }

  private async render(rows: Array<typeof interactions.$inferSelect>, capabilities: ChannelCapabilities, agentName: string | null): Promise<WebChatMessage[]> {
    if (!rows.length) return [];
    const parts = await this.db.select().from(interactionParts).where(inArray(interactionParts.interactionId, rows.map((r) => r.id))).orderBy(asc(interactionParts.idx));
    const humanIds = [...new Set(rows.filter((r) => r.actorType === 'HUMAN' && r.actorId).map((r) => r.actorId!))];
    const names = new Map(
      humanIds.length ? (await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, humanIds))).map((u) => [u.id, u.name.split(' ')[0] ?? u.name]) : [],
    );
    const out: WebChatMessage[] = [];
    for (const r of rows) {
      const own = parts.filter((p) => p.interactionId === r.id).map((p) => p.content as unknown as InteractionPart);
      const safe = r.actorType === 'CUSTOMER' ? own.filter((p) => p.type !== 'TOOL_RESULT') : customerSafeParts(own, capabilities).parts;
      out.push({
        id: r.id,
        seq: r.seq,
        from: r.actorType === 'CUSTOMER' ? 'customer' : r.actorType === 'HUMAN' ? 'human' : 'agent',
        name: r.actorType === 'HUMAN' && r.actorId ? (names.get(r.actorId) ?? null) : r.actorType === 'AGENT' ? agentName : null,
        parts: await this.media.signParts(safe),
        deliveryStatus: r.deliveryStatus,
        at: r.createdAt.toISOString(),
      });
    }
    return out;
  }
}
