import { and, desc, eq, gt } from 'drizzle-orm';
import { readGenerations, type CacheScope } from '@ocso/application';
import {
  conversationSummaries,
  customers,
  handoffs,
  internalNotes,
  promptVersions,
  type DbOrTx,
  type virtualAgents,
  type conversations,
  type channels,
} from '@ocso/db';
import { compilePrompt, type CompiledPrompt, type CompileInput, type HandoverContext, type ModelInputCapabilities, type PromptComponents } from '@ocso/prompt-compiler';
import { loadAgentToolCatalog, type AgentToolCatalog } from '../tools/catalog.js';
import { loadHistory, loadPending } from './history.js';
import type { CacheLayer, CachedAgentPrefix, ConversationCacheEntry, HotContextCache } from './turn-cache.js';

type ConversationRow = typeof conversations.$inferSelect;
type AgentRow = typeof virtualAgents.$inferSelect;
type ChannelRow = typeof channels.$inferSelect;

export interface TurnContext {
  compileInput: CompileInput;
  compiled: CompiledPrompt;
  catalog: AgentToolCatalog;
  pendingSeqTo: number;
  windowStartSeq: number;
  cacheLayer: CacheLayer;
}

export interface ContextBuilderOptions {
  historyWindow: number;
  mediaWindow: number;
  timezone: string;
}

const sameGenerations = (a: Record<string, number>, b: Record<string, number>) =>
  Object.keys(b).every((k) => a[k] === b[k]) && Object.keys(a).length === Object.keys(b).length;

/**
 * Builds the compile input for a turn using the OCSO turn cache (docs/05 §4):
 * warm conversations only fetch interactions added since the last turn; any
 * generation/version change invalidates the affected part.
 */
export class ContextBuilder {
  private readonly agentPrefixes = new Map<string, CachedAgentPrefix & { generation: number }>();

  constructor(
    private readonly db: DbOrTx,
    private readonly hot: HotContextCache,
    private readonly options: ContextBuilderOptions,
  ) {}

  async build(conv: ConversationRow, agent: AgentRow, channel: ChannelRow | null, capabilities: ModelInputCapabilities, resumingFromHuman: boolean): Promise<TurnContext> {
    const scopes: CacheScope[] = [`agent:${agent.id}`, `customer:${conv.customerId}`, 'policy', 'global'];
    if (conv.channelId) scopes.push(`channel:${conv.channelId}`);
    if (agent.modelProfileId) scopes.push(`profile:${agent.modelProfileId}`);
    const generations = await readGenerations(this.db, scopes);
    const cached = this.hot.get(conv.id);
    const layer: CacheLayer = cached && sameGenerations(cached.generations, generations) ? 'HOT' : 'COLD';
    const entry: ConversationCacheEntry =
      layer === 'HOT' ? cached! : { generations, agent: null, customer: null, summary: null, history: [], historyThroughSeq: 0, lastUsed: Date.now() };

    const prefix = await this.agentPrefix(agent, generations[`agent:${agent.id}`] ?? 1);
    const customer = await this.customerContext(conv.customerId);
    const summary = await this.summary(conv, entry);
    const history = await this.history(conv, entry, summary?.context?.coversThroughSeq ?? 0);
    const pending = await loadPending(this.db, conv.id, conv.lastProcessedSeq);
    // Unanswered customer messages go in `current`; everything else visible so far (including the agent's own
    // replies, which land after lastProcessedSeq) is history.
    const pendingSeqs = new Set(pending.map((p) => p.seq));
    const recent = history.filter((h) => !pendingSeqs.has(h.seq));
    const handover = resumingFromHuman ? await this.handover(conv.id) : null;

    const compileInput: CompileInput = {
      agent: { id: agent.id, name: agent.name, conversationType: agent.conversationType },
      promptVersion: { id: prefix.promptVersionId, version: 0, components: prefix.components as PromptComponents },
      tools: prefix.catalog.specs,
      channel: { kind: channel?.kind ?? 'WEBCHAT', label: channel?.name ?? 'Chat' },
      customer,
      summary: summary?.context ?? null,
      handover,
      recent,
      current: pending,
      capabilities: {
        imageInput: capabilities.imageInput && agent.multimodal.imageInput,
        fileInput: capabilities.fileInput && agent.multimodal.documentInput,
        audioInput: capabilities.audioInput && agent.multimodal.audioInput,
      },
      mediaWindow: this.options.mediaWindow,
      today: new Intl.DateTimeFormat('en-CA', { timeZone: this.options.timezone }).format(new Date()),
    };
    this.hot.set(conv.id, { ...entry, generations, agent: prefix, customer: { contextVersion: 0, context: customer }, summary, history, historyThroughSeq: conv.lastSeq, lastUsed: Date.now() });
    return {
      compileInput,
      compiled: compilePrompt(compileInput),
      catalog: prefix.catalog,
      pendingSeqTo: pending.at(-1)?.seq ?? conv.lastProcessedSeq,
      windowStartSeq: history[0]?.seq ?? conv.lastProcessedSeq + 1,
      cacheLayer: layer,
    };
  }

  /** Agent prefix (prompt components + tool catalog) shared by all conversations of an agent. */
  private async agentPrefix(agent: AgentRow, generation: number): Promise<CachedAgentPrefix> {
    const cached = this.agentPrefixes.get(agent.id);
    if (cached && cached.generation === generation && cached.promptVersionId === agent.activePromptVersionId) return cached;
    if (!agent.activePromptVersionId) throw new Error(`agent ${agent.id} has no active prompt version`);
    const [version] = await this.db.select().from(promptVersions).where(eq(promptVersions.id, agent.activePromptVersionId));
    const catalog = await loadAgentToolCatalog(this.db, agent.id);
    const prefix = { promptVersionId: version!.id, components: version!.components, catalog, generation };
    this.agentPrefixes.set(agent.id, prefix);
    return prefix;
  }

  private async customerContext(customerId: string) {
    const [c] = await this.db.select().from(customers).where(eq(customers.id, customerId));
    return { customerId, displayName: c?.displayName ?? undefined, language: c?.language ?? undefined, attributes: c?.attributes ?? {} };
  }

  private async summary(conv: ConversationRow, entry: ConversationCacheEntry): Promise<ConversationCacheEntry['summary']> {
    if (entry.summary && entry.summary.version === conv.summaryVersion) return entry.summary;
    const [row] = await this.db
      .select()
      .from(conversationSummaries)
      .where(and(eq(conversationSummaries.conversationId, conv.id), eq(conversationSummaries.kind, 'ROLLING')))
      .orderBy(desc(conversationSummaries.version))
      .limit(1);
    return { version: conv.summaryVersion, context: row ? { version: row.version, coversThroughSeq: row.coversThroughSeq, text: row.text } : null };
  }

  /**
   * Every customer-visible message through `lastSeq` — not `lastProcessedSeq`, which is the last customer message
   * a turn handled: the agent's reply to it comes after, and cutting there hid the agent's own previous answer.
   * Warm path fetches only the delta since the cached bundle; cold path loads the window.
   */
  private async history(conv: ConversationRow, entry: ConversationCacheEntry, summaryCovers: number) {
    const window = this.options.historyWindow;
    if (entry.historyThroughSeq > 0 && entry.historyThroughSeq <= conv.lastSeq) {
      const delta = await loadHistory(this.db, conv.id, entry.historyThroughSeq, conv.lastSeq, window);
      return [...entry.history, ...delta].filter((h) => h.seq > summaryCovers).slice(-window);
    }
    return loadHistory(this.db, conv.id, summaryCovers, conv.lastSeq, window);
  }

  private async handover(conversationId: string): Promise<HandoverContext | null> {
    const [summary] = await this.db
      .select()
      .from(conversationSummaries)
      .where(and(eq(conversationSummaries.conversationId, conversationId), eq(conversationSummaries.kind, 'HANDOVER')))
      .orderBy(desc(conversationSummaries.version))
      .limit(1);
    if (!summary) return null;
    const [handoff] = await this.db.select().from(handoffs).where(eq(handoffs.conversationId, conversationId)).orderBy(desc(handoffs.requestedAt)).limit(1);
    const notes = await this.db
      .select({ body: internalNotes.body })
      .from(internalNotes)
      .where(and(eq(internalNotes.conversationId, conversationId), eq(internalNotes.passToAgent, true), handoff ? gt(internalNotes.createdAt, handoff.requestedAt) : undefined));
    return { summary: summary.text, notes: notes.map((n) => n.body) };
  }
}
