import { and, desc, eq, ilike, lt, ne, or } from 'drizzle-orm';
import type { ToolResultOutput, ToolSpec } from '@ocso/domain';
import { conversations, interactions, type DbOrTx } from '@ocso/db';
import { z } from 'zod';

export const HANDOFF_TOOL = 'ocso_request_handoff';
export const SEARCH_HISTORY_TOOL = 'ocso_search_history';

export const HandoffArgs = z.object({
  reason: z.string().min(3).max(300),
  summary: z.string().min(3).max(1_200),
  priority: z.enum(['P1', 'P2', 'P3', 'P4']).optional(),
  customerAskedForHuman: z.boolean().optional(),
});
export type HandoffArgs = z.infer<typeof HandoffArgs>;

const SearchArgs = z.object({ query: z.string().min(2).max(200) });

/** Built-in OCSO tools — always available, still authorized and audited like any tool. */
export const BUILTIN_TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: HANDOFF_TOOL,
    description:
      'Hand this conversation to a human colleague. Use when the escalation policy requires it, the customer asks for a human, or you cannot help safely. Provide a short reason and a three-line summary: what happened, what you did, what the human needs to decide.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Short reason, e.g. "refund above authority"' },
        summary: { type: 'string', description: 'Three lines for the human' },
        priority: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4'] },
        customerAskedForHuman: { type: 'boolean' },
      },
      required: ['reason', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: SEARCH_HISTORY_TOOL,
    description: "Search this customer's earlier messages (older than the recent conversation window) for a word or phrase.",
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

export const isBuiltin = (name: string) => name === HANDOFF_TOOL || name === SEARCH_HISTORY_TOOL;

/** Retrievable older history (docs/05 §6): earlier customer-visible messages of this customer. */
export async function searchHistory(db: DbOrTx, customerId: string, beforeSeqOfConversation: { conversationId: string; seq: number }, args: unknown): Promise<ToolResultOutput> {
  const parsed = SearchArgs.safeParse(args);
  if (!parsed.success) return { type: 'error', value: 'query must be 2–200 characters' };
  const like = `%${parsed.data.query.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const rows = await db
    .select({ seq: interactions.seq, actor: interactions.actorType, text: interactions.preview, at: interactions.createdAt, conv: interactions.conversationId })
    .from(interactions)
    .innerJoin(conversations, eq(conversations.id, interactions.conversationId))
    .where(
      and(
        eq(conversations.customerId, customerId),
        eq(interactions.visibility, 'CUSTOMER'),
        eq(interactions.kind, 'MESSAGE'),
        ilike(interactions.preview, like),
        // Earlier conversations, or messages older than the recent window of this one.
        or(ne(interactions.conversationId, beforeSeqOfConversation.conversationId), lt(interactions.seq, beforeSeqOfConversation.seq)),
      ),
    )
    .orderBy(desc(interactions.createdAt))
    .limit(10);
  return {
    type: 'json',
    value: rows.map((r) => ({ at: r.at.toISOString(), from: r.actor.toLowerCase(), text: r.text })),
  };
}
