import { and, desc, eq, sql } from 'drizzle-orm';
import { partToPlainText } from '@ocso/domain';
import { conversationSummaries, conversations, virtualAgents, uuidv7, type Db } from '@ocso/db';
import type { ModelGateway } from '../model/gateway.js';
import { loadHistory } from '../context/history.js';

export interface SummaryPolicy {
  /** Recent messages kept verbatim in context (must match the context builder window). */
  historyWindow: number;
  /** Summarize once this many answered messages fall outside window + current summary. */
  minNewMessages: number;
}

const SUMMARY_SYSTEM = `You maintain a rolling summary of a customer conversation for an AI agent and human colleagues.
Write at most 12 short lines: the customer's situation and goal, facts established (amounts, references, dates), actions already taken (including tool results), commitments made, and what is still open.
Never include secrets, full card numbers or credentials. Do not address the customer.`;

/**
 * Context compaction (docs/05 §6): older answered messages are folded into a
 * versioned rolling summary; the full history stays immutable in PostgreSQL.
 */
export class SummaryService {
  constructor(
    private readonly db: Db,
    private readonly gateway: ModelGateway,
    private readonly policy: SummaryPolicy,
  ) {}

  async summarize(conversationId: string, correlationId: string): Promise<'summarized' | 'not_needed'> {
    const [conv] = await this.db.select().from(conversations).where(eq(conversations.id, conversationId));
    if (!conv) return 'not_needed';
    const [agent] = await this.db.select().from(virtualAgents).where(eq(virtualAgents.id, conv.agentId));
    const profileId = agent?.summarizerProfileId ?? agent?.modelProfileId;
    if (!profileId) return 'not_needed';
    const [previous] = await this.db
      .select()
      .from(conversationSummaries)
      .where(and(eq(conversationSummaries.conversationId, conversationId), eq(conversationSummaries.kind, 'ROLLING')))
      .orderBy(desc(conversationSummaries.version))
      .limit(1);
    const covered = previous?.coversThroughSeq ?? 0;
    // Everything answered except the most recent window becomes summary material.
    const answered = await loadHistory(this.db, conversationId, covered, conv.lastProcessedSeq, 1_000);
    const toFold = answered.slice(0, Math.max(0, answered.length - this.policy.historyWindow));
    if (toFold.length < this.policy.minNewMessages) return 'not_needed';
    const coversThroughSeq = toFold.at(-1)!.seq;
    const transcript = toFold
      .map((h) => `${h.actorType === 'CUSTOMER' ? 'Customer' : h.actorType === 'HUMAN' ? `Colleague${h.actorName ? ` ${h.actorName}` : ''}` : 'Agent'}: ${h.parts.map(partToPlainText).join(' ')}`)
      .join('\n');
    const result = await this.gateway.run({
      profileId,
      purpose: 'SUMMARY',
      system: [{ key: 'summary_instructions', text: SUMMARY_SYSTEM, stable: true, breakpointAfter: 'AGENT_PREFIX' }],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `${previous ? `Previous summary (through message ${previous.coversThroughSeq}):\n${previous.text}\n\n` : ''}New messages to fold in:\n${transcript}`,
            },
          ],
        },
      ],
      tools: [],
      context: { correlationId, conversationId, agentId: conv.agentId, purpose: 'SUMMARY' },
    });
    const text = result.text.trim();
    if (!text) return 'not_needed';
    await this.db.transaction(async (tx) => {
      const version = (previous?.version ?? 0) + 1;
      await tx.insert(conversationSummaries).values({
        id: uuidv7(),
        conversationId,
        version,
        coversThroughSeq,
        kind: 'ROLLING',
        text,
        usageEventId: result.usageEventId,
      });
      await tx.update(conversations).set({ summaryVersion: sql`GREATEST(${conversations.summaryVersion}, ${version})` }).where(eq(conversations.id, conversationId));
    });
    return 'summarized';
  }
}
