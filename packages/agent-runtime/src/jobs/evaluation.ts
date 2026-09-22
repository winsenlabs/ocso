import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { partToPlainText } from '@ocso/domain';
import { channels, conversations, customers, evaluationResults, evaluationRuns, interactions, turns, uuidv7, virtualAgents, type Db } from '@ocso/db';
import { compilePrompt, type HistoryEntry, type PromptComponents } from '@ocso/prompt-compiler';
import { sanitizeForAudit } from '@ocso/tools';
import type { ModelGateway } from '../model/gateway.js';
import { basicChannelContext, type ChannelContextResolver } from '../context/channel-context.js';
import { loadHistory } from '../context/history.js';
import { HANDOFF_TOOL, isBuiltin } from '../tools/builtins.js';
import { loadAgentToolCatalog, type AgentToolCatalog } from '../tools/catalog.js';

export type EvaluationFlag = 'handoff_requested' | 'handoff_differs' | 'tool_call_differs' | 'empty_reply' | 'error';

export interface EvaluationCase {
  conversationId: string;
  /** Seq of the (last) customer message the replay answers. */
  seq: number;
  recent: HistoryEntry[];
  current: HistoryEntry[];
  baselineText: string;
  baselineTools: string[];
  baselineHandoff: boolean;
}

export interface EvaluationOutcome {
  status: 'COMPLETED' | 'FAILED' | 'SKIPPED';
  summary?: Record<string, number>;
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const text = (entries: readonly HistoryEntry[]) => entries.map((e) => e.parts.map(partToPlainText).join(' ')).join('\n').trim();

/**
 * Pick the replay point: the latest AGENT reply that directly follows a
 * customer message. Baseline = that reply (consecutive agent messages);
 * current = the customer messages it answered; recent = earlier messages.
 */
export function pickCase(history: readonly HistoryEntry[], historyWindow: number): Omit<EvaluationCase, 'conversationId' | 'baselineTools' | 'baselineHandoff'> | null {
  for (let j = history.length - 1; j > 0; j--) {
    if (history[j]!.actorType !== 'AGENT' || history[j - 1]!.actorType !== 'CUSTOMER') continue;
    let end = j;
    while (end + 1 < history.length && history[end + 1]!.actorType === 'AGENT') end++;
    let start = j - 1;
    while (start - 1 >= 0 && history[start - 1]!.actorType === 'CUSTOMER') start--;
    const current = history.slice(start, j);
    return { seq: current.at(-1)!.seq, recent: history.slice(Math.max(0, start - historyWindow), start), current, baselineText: text(history.slice(j, end + 1)) };
  }
  return null;
}

/**
 * Replay evaluation (design/02 Versions "run against N replay cases"): the
 * candidate prompt answers historical customer turns with the same history.
 * Tools are NEVER executed — intended calls are recorded — so a run has no
 * side effects on customers or business systems. See
 * EVALUATION_SUMMARY_DEFINITION in @ocso/application for the flag semantics;
 * when the candidate calls any tool its first-step text is not final, so only
 * tool and handoff behavior are compared for that case.
 */
export class EvaluationService {
  constructor(
    private readonly db: Db,
    private readonly gateway: ModelGateway,
    private readonly options: { historyWindow?: number; channelContext?: ChannelContextResolver | undefined } = {},
  ) {}

  async run(evaluationRunId: string, correlationId = `evaluation:${evaluationRunId}`): Promise<EvaluationOutcome> {
    const [run] = await this.db
      .update(evaluationRuns)
      .set({ status: 'RUNNING' })
      .where(and(eq(evaluationRuns.id, evaluationRunId), inArray(evaluationRuns.status, ['QUEUED', 'RUNNING'])))
      .returning();
    if (!run) return { status: 'SKIPPED' };
    // A redelivered run restarts from scratch (results are derived state).
    await this.db.delete(evaluationResults).where(eq(evaluationResults.runId, run.id));
    const [agent] = await this.db.select().from(virtualAgents).where(eq(virtualAgents.id, run.agentId));
    if (!agent?.modelProfileId) {
      await this.finish(run.id, 'FAILED', { cases: 0, errors: 1 });
      return { status: 'FAILED', summary: { cases: 0, errors: 1 } };
    }
    const catalog = await loadAgentToolCatalog(this.db, agent.id);
    const summary: Record<string, number> = { cases: 0, changed: 0, unchanged: 0, handoff_requested: 0, handoff_differs: 0, tool_call_differs: 0, empty_reply: 0, errors: 0, skipped: 0 };
    const sample = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.agentId, agent.id),
          eq(conversations.controlState, 'RESOLVED'),
          sql`EXISTS (SELECT 1 FROM interactions i WHERE i.conversation_id = ${conversations.id} AND i.actor_type = 'AGENT' AND i.kind = 'MESSAGE')`,
        ),
      )
      .orderBy(desc(conversations.resolvedAt))
      .limit(run.caseCount);
    for (const { id } of sample) {
      const c = await this.buildCase(id);
      if (!c) {
        summary['skipped']!++;
        continue;
      }
      summary['cases']!++;
      const flags = await this.replay(run.id, run.candidateComponents as PromptComponents, agent, catalog, c, correlationId);
      if (flags.changed) summary['changed']!++;
      else if (!flags.list.includes('error')) summary['unchanged']!++;
      for (const f of flags.list) summary[f === 'error' ? 'errors' : f] = (summary[f === 'error' ? 'errors' : f] ?? 0) + 1;
    }
    await this.finish(run.id, 'COMPLETED', summary);
    return { status: 'COMPLETED', summary };
  }

  private async buildCase(conversationId: string): Promise<EvaluationCase | null> {
    const [conv] = await this.db.select({ lastSeq: conversations.lastSeq }).from(conversations).where(eq(conversations.id, conversationId));
    if (!conv) return null;
    const history = await loadHistory(this.db, conversationId, 0, conv.lastSeq, 1_000);
    const picked = pickCase(history, this.options.historyWindow ?? 20);
    if (!picked) return null;
    const [reply] = await this.db
      .select({ turnId: interactions.turnId, outcome: turns.outcome })
      .from(interactions)
      .leftJoin(turns, eq(turns.id, interactions.turnId))
      .where(and(eq(interactions.conversationId, conversationId), sql`${interactions.seq} > ${picked.seq}`, eq(interactions.actorType, 'AGENT'), eq(interactions.kind, 'MESSAGE')))
      .orderBy(interactions.seq)
      .limit(1);
    let baselineTools: string[] = [];
    if (reply?.turnId) {
      // First model step of the baseline turn: calls issued before any call of that turn completed.
      const { rows } = await this.db.execute<{ name: string }>(sql`
        WITH calls AS (
          SELECT coalesce(t.model_name, tc.tool_name) AS name, tc.requested_at, tc.completed_at
            FROM tool_calls tc LEFT JOIN tools t ON t.id = tc.tool_id
           WHERE tc.turn_id = ${reply.turnId} AND tc.actor_type = 'AGENT')
        SELECT DISTINCT name FROM calls
         WHERE requested_at <= coalesce((SELECT min(completed_at) FROM calls), 'infinity'::timestamptz)`);
      baselineTools = rows.map((r) => r.name).filter((n) => !isBuiltin(n)).sort();
    }
    return { conversationId, ...picked, baselineTools, baselineHandoff: reply?.outcome === 'HANDOFF' };
  }

  private async replay(
    runId: string,
    components: PromptComponents,
    agent: typeof virtualAgents.$inferSelect,
    catalog: AgentToolCatalog,
    c: EvaluationCase,
    correlationId: string,
  ): Promise<{ changed: boolean; list: EvaluationFlag[] }> {
    const customerText = text(c.current);
    const record = (values: { candidateText: string | null; candidateToolCalls: unknown; changed: boolean; flags: EvaluationFlag[] }) =>
      this.db.insert(evaluationResults).values({ id: uuidv7(), runId, conversationId: c.conversationId, seq: c.seq, customerText, baselineText: c.baselineText, ...values });
    try {
      const [ctx] = await this.db
        .select({ channel: channels, customerId: customers.id, displayName: customers.displayName, language: customers.language, attributes: customers.attributes })
        .from(conversations)
        .innerJoin(customers, eq(customers.id, conversations.customerId))
        .leftJoin(channels, eq(channels.id, conversations.channelId))
        .where(eq(conversations.id, c.conversationId));
      const compiled = compilePrompt({
        agent: { id: agent.id, name: agent.name, conversationType: agent.conversationType },
        promptVersion: { id: `eval:${runId}`, version: 0, components },
        tools: catalog.specs,
        channel: ctx?.channel ? (this.options.channelContext ?? basicChannelContext)(ctx.channel) : null,
        customer: ctx ? { customerId: ctx.customerId, displayName: ctx.displayName ?? undefined, language: ctx.language ?? undefined, attributes: ctx.attributes } : null,
        summary: null,
        handover: null,
        recent: c.recent,
        current: c.current,
        capabilities: { imageInput: false, fileInput: false, audioInput: false },
        mediaWindow: 0,
        today: new Date().toISOString().slice(0, 10),
      });
      const result = await this.gateway.run({
        profileId: agent.modelProfileId!,
        purpose: 'EVALUATION',
        system: compiled.system,
        messages: compiled.messages,
        tools: compiled.tools,
        context: { correlationId, conversationId: c.conversationId, agentId: agent.id, purpose: 'EVALUATION' },
      });
      const candidateText = result.text.trim();
      const intended = result.toolCalls.map((t) => ({ toolName: t.toolName, input: sanitizeForAudit(t.input) }));
      const handoff = intended.some((t) => t.toolName === HANDOFF_TOOL);
      const tools = [...new Set(intended.map((t) => t.toolName).filter((n) => !isBuiltin(n)))].sort();
      const flags: EvaluationFlag[] = [];
      if (handoff) flags.push('handoff_requested');
      if (handoff !== c.baselineHandoff) flags.push('handoff_differs');
      if (tools.join('|') !== c.baselineTools.join('|')) flags.push('tool_call_differs');
      if (!candidateText && !intended.length) flags.push('empty_reply');
      // Any intended tool call (including built-ins) means the candidate's text is not its final reply.
      const textDiffers = intended.length === 0 && normalize(candidateText) !== normalize(c.baselineText);
      const changed = textDiffers || flags.includes('tool_call_differs') || flags.includes('handoff_differs');
      await record({ candidateText: candidateText || null, candidateToolCalls: intended, changed, flags });
      return { changed, list: flags };
    } catch {
      await record({ candidateText: null, candidateToolCalls: null, changed: false, flags: ['error'] });
      return { changed: false, list: ['error'] };
    }
  }

  private async finish(id: string, status: 'COMPLETED' | 'FAILED', summary: Record<string, number>): Promise<void> {
    await this.db.update(evaluationRuns).set({ status, summary, completedAt: new Date() }).where(eq(evaluationRuns.id, id));
  }
}
