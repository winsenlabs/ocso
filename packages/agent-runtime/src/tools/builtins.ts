import { and, desc, eq, ilike, lt, ne, or } from 'drizzle-orm';
import type { ToolResultOutput, ToolSpec } from '@ocso/domain';
import { conversations, interactions, type DbOrTx } from '@ocso/db';
import { ToolProviderRegistry, type FirstPartyTool, type HandoffRequest, type ToolInvocation, type ToolOutcome, type ToolProvider, type ToolProviderSource } from '@ocso/tools';
import { z } from 'zod';
import { TRANSFER_TOOL, TRANSFER_TOOL_DEFINITION, runTransferTool } from './transfer-tool.js';

export const HANDOFF_TOOL = 'ocso_request_handoff';
export const SEARCH_HISTORY_TOOL = 'ocso_search_history';
/** Registry key of the built-in tool source. */
export const BUILTIN_TOOL_SOURCE = 'ocso-builtin';

export const HandoffArgs: z.ZodType<HandoffRequest> = z.object({
  reason: z.string().min(3).max(300),
  summary: z.string().min(3).max(1_200),
  priority: z.enum(['P1', 'P2', 'P3', 'P4']).optional(),
  customerAskedForHuman: z.boolean().optional(),
});
export type HandoffArgs = HandoffRequest;

const SearchArgs = z.object({ query: z.string().min(2).max(200) });

/**
 * Built-in OCSO tools. A first-party ToolProvider source registered alongside
 * MCP: every call is authorized (authorizeToolCall) and audited (tool_calls)
 * by ToolRunner exactly like an MCP tool. The JSON Schemas mirror the zod
 * parsers so invalid arguments are denied before execution.
 */
export const BUILTIN_TOOLS: readonly FirstPartyTool[] = [
  {
    name: HANDOFF_TOOL,
    // Changes who owns the conversation, but the handoff itself is the safe path: never gated by confirmation.
    riskClass: 'WRITE',
    description:
      'Hand this conversation to a human colleague. Use when the escalation policy requires it, the customer asks for a human, or you cannot help safely. Provide a short reason and a three-line summary: what happened, what you did, what the human needs to decide.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', minLength: 3, maxLength: 300, description: 'Short reason, e.g. "refund above authority"' },
        summary: { type: 'string', minLength: 3, maxLength: 1_200, description: 'Three lines for the human' },
        priority: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4'] },
        customerAskedForHuman: { type: 'boolean' },
      },
      required: ['reason', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: SEARCH_HISTORY_TOOL,
    riskClass: 'READ',
    description: "Search this customer's earlier messages (older than the recent conversation window) for a word or phrase.",
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 2, maxLength: 200 } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  // Added to a conversation's catalog only when its queue has transfer targets (context builder).
  TRANSFER_TOOL_DEFINITION,
];

/** Model-facing definitions of the built-ins. */
export const BUILTIN_TOOL_SPECS: readonly ToolSpec[] = BUILTIN_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

export const isBuiltin = (name: string) => BUILTIN_TOOLS.some((t) => t.name === name);

type Handler = (call: ToolInvocation) => Promise<Omit<Extract<ToolOutcome, { status: 'SUCCEEDED' }>, 'latencyMs'> | { status: 'FAILED'; errorCategory: 'validation' | 'internal'; message: string }>;

/**
 * The built-in tools as a first-party ToolProviderSource. `invoke` runs only
 * after ToolRunner authorized the call and wrote its tool_calls row.
 */
export function createBuiltinToolSource(db: DbOrTx): ToolProviderSource {
  const handlers: Record<string, Handler> = {
    [HANDOFF_TOOL]: async (call) => {
      const parsed = HandoffArgs.safeParse(call.args);
      if (!parsed.success) return { status: 'FAILED', errorCategory: 'validation', message: 'reason and summary are required' };
      return {
        status: 'SUCCEEDED',
        effect: { type: 'handoff', request: parsed.data },
        output: { type: 'json', value: { status: 'handoff_requested', instruction: 'Tell the customer a colleague will continue here shortly. Do not promise a time.' } },
      };
    },
    [TRANSFER_TOOL]: (call) => runTransferTool(db, call),
    [SEARCH_HISTORY_TOOL]: async (call) => {
      if (!call.scope) return { status: 'FAILED', errorCategory: 'internal', message: 'History search needs a conversation' };
      const output = await searchHistory(db, call.scope.customerId, { conversationId: call.scope.conversationId, seq: call.scope.historyWindowStartSeq }, call.args);
      if (output.type === 'error') return { status: 'FAILED', errorCategory: 'validation', message: String(output.value) };
      return { status: 'SUCCEEDED', output };
    },
  };
  const provider: ToolProvider = {
    connectionId: null,
    async invoke(call) {
      const started = performance.now();
      const latencyMs = () => Math.round(performance.now() - started);
      const handler = Object.hasOwn(handlers, call.toolName) ? handlers[call.toolName] : undefined;
      if (!handler) return { status: 'FAILED', errorCategory: 'tool_unavailable', message: 'Unknown built-in tool', latencyMs: latencyMs() };
      try {
        return { ...(await handler(call)), latencyMs: latencyMs() };
      } catch {
        return { status: 'FAILED', errorCategory: 'internal', message: 'The built-in tool failed', latencyMs: latencyMs() };
      }
    },
  };
  return { kind: BUILTIN_TOOL_SOURCE, connectionBacked: false, tools: BUILTIN_TOOLS, provider: async () => provider };
}

/**
 * The runtime's one tool-provider registry: the built-in source plus the
 * given sources (MCP connections via `connectionToolSource`).
 */
export function createToolProviderRegistry(db: DbOrTx, ...sources: ToolProviderSource[]): ToolProviderRegistry {
  const registry = new ToolProviderRegistry().register(createBuiltinToolSource(db));
  for (const source of sources) registry.register(source);
  return registry;
}

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
