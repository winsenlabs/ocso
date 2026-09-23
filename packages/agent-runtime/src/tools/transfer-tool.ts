import { and, desc, eq, sql } from 'drizzle-orm';
import { conversations, interactions, turns, type DbOrTx } from '@ocso/db';
import { aiTransferTargets } from '@ocso/application';
import type { FirstPartyTool, ToolInvocation } from '@ocso/tools';
import { z } from 'zod';

/**
 * `ocso_transfer_to_queue` (PM/research/11 §5.5): an agent moves the
 * conversation to another queue and that queue's agent, with a handover
 * summary. Offered only when the conversation's queue has transfer targets
 * with an agent; the model-facing schema enumerates exactly those queues.
 */
export const TRANSFER_TOOL = 'ocso_transfer_to_queue';

const DESCRIPTION =
  'Transfer this conversation to another team’s AI agent when the customer needs something that team handles. The receiving agent continues immediately with your summary. Give the queue, a short reason and a summary of what the customer needs and what you already did. Do not use this to reach a human (use ocso_request_handoff).';

const argsSchema = (queues: readonly string[] | null) => ({
  type: 'object',
  properties: {
    queue: queues ? { type: 'string', enum: [...queues], description: 'The queue to transfer to' } : { type: 'string', minLength: 1, maxLength: 120 },
    reason: { type: 'string', minLength: 3, maxLength: 300 },
    summary: { type: 'string', minLength: 3, maxLength: 1_200, description: 'What the customer needs and what you already did' },
  },
  required: ['queue', 'reason', 'summary'],
  additionalProperties: false,
});

/** Registered with the built-ins so the registry can execute it; never offered with this generic schema. */
export const TRANSFER_TOOL_DEFINITION: FirstPartyTool = { name: TRANSFER_TOOL, riskClass: 'WRITE', description: DESCRIPTION, inputSchema: argsSchema(null) };

/** First-party tools that depend on the conversation and are added per turn, not to the agent's cached catalog. */
export const CONVERSATION_SCOPED_TOOLS: ReadonlySet<string> = new Set([TRANSFER_TOOL]);

/** The tool as this conversation's model sees it: `queue` is an enum of its queue's transfer targets. */
export function transferToolFor(targets: ReadonlyArray<{ name: string; agentName: string; attributes: Record<string, string> }>): FirstPartyTool {
  const lines = targets.map((t) => {
    const attrs = Object.entries(t.attributes).map(([k, v]) => `${k}=${v}`).join(', ');
    return `- ${t.name} (agent ${t.agentName}${attrs ? `; ${attrs}` : ''})`;
  });
  return { ...TRANSFER_TOOL_DEFINITION, description: `${DESCRIPTION}\nQueues you can transfer to:\n${lines.join('\n')}`, inputSchema: argsSchema(targets.map((t) => t.name)) };
}

const Args = z.object({ queue: z.string().min(1).max(120), reason: z.string().min(3).max(300), summary: z.string().min(3).max(1_200) });

type Outcome =
  | { status: 'SUCCEEDED'; output: { type: 'json'; value: unknown }; effect: { type: 'transfer'; request: { queueId: string; reason: string; summary: string } } }
  | { status: 'FAILED'; errorCategory: 'validation' | 'internal'; message: string };

/** Validates the call against the live queue configuration; the transfer itself happens when the turn completes. */
export async function runTransferTool(db: DbOrTx, call: ToolInvocation): Promise<Outcome> {
  if (!call.scope) return { status: 'FAILED', errorCategory: 'internal', message: 'Transfers need a conversation' };
  const parsed = Args.safeParse(call.args);
  if (!parsed.success) return { status: 'FAILED', errorCategory: 'validation', message: 'queue, reason and summary are required' };
  const [conv] = await db.select({ queueId: conversations.queueId, agentId: conversations.agentId, lastSeq: conversations.lastSeq }).from(conversations).where(eq(conversations.id, call.scope.conversationId));
  const targets = await aiTransferTargets(db, conv?.queueId ?? null, conv?.agentId ?? null);
  const target = targets.find((t) => t.queue.name.toLowerCase() === parsed.data.queue.trim().toLowerCase());
  if (!target) return { status: 'FAILED', errorCategory: 'validation', message: `You cannot transfer to "${parsed.data.queue}". Answer the customer yourself or hand off to a human.` };
  if (await justTransferred(db, call.scope.conversationId)) {
    return { status: 'FAILED', errorCategory: 'validation', message: 'This conversation was just transferred to you. Answer the customer yourself; transfer again only after they write.' };
  }
  return {
    status: 'SUCCEEDED',
    output: { type: 'json', value: { status: 'transfer_requested', queue: target.queue.name, instruction: `Tell the customer in one short sentence that ${target.agentName} from ${target.queue.name} will take it from here. Do not answer their question yourself.` } },
    effect: { type: 'transfer', request: { queueId: target.queue.id, reason: parsed.data.reason, summary: parsed.data.summary } },
  };
}

/** A transfer already happened for the customer's current messages (prevents A → B → A loops). */
async function justTransferred(db: DbOrTx, conversationId: string): Promise<boolean> {
  const [last] = await db
    .select({ outcome: turns.outcome, seqTo: turns.seqTo })
    .from(turns)
    .where(and(eq(turns.conversationId, conversationId), eq(turns.status, 'COMPLETED')))
    .orderBy(desc(turns.startedAt))
    .limit(1);
  if (last?.outcome !== 'TRANSFERRED') return false;
  const [latest] = await db
    .select({ seq: sql<number | null>`max(${interactions.seq})` })
    .from(interactions)
    .where(and(eq(interactions.conversationId, conversationId), eq(interactions.actorType, 'CUSTOMER'), eq(interactions.kind, 'MESSAGE')));
  return (latest?.seq ?? 0) <= last.seqTo;
}
