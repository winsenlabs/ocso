import { and, asc, desc, eq } from 'drizzle-orm';
import { Permission, assertCan, viaInternalAgent, type Principal } from '@ocso/auth';
import { SettingsService } from '@ocso/application';
import type { ModelGateway } from '@ocso/agent-runtime';
import { isDomainError, notFound, validation, type ModelContentPart, type ModelMessage } from '@ocso/domain';
import { internalAgentMessages, internalAgentThreads, uuidv7, type Db } from '@ocso/db';
import type { ObjectLink, ToolAnswer } from './contract.js';
import type { InternalActionService, PendingAction } from './actions.js';
import { internalAgentInstructions } from './instructions.js';
import type { InternalToolRegistry } from './registry.js';

export interface AgentSink {
  text(delta: string): void;
  step(label: string): void;
  links(links: ObjectLink[]): void;
  table(table: NonNullable<ToolAnswer['table']>): void;
  action(action: PendingAction): void;
  denied(message: string): void;
}

type StoredPart =
  | { type: 'text'; text: string }
  | { type: 'links'; links: ObjectLink[] }
  | { type: 'table'; table: NonNullable<ToolAnswer['table']> }
  | { type: 'action'; action: PendingAction }
  | { type: 'tool'; name: string; args: unknown; ok: boolean }
  | { type: 'denied'; text: string };

const MAX_STEPS = 6;
const HISTORY_MESSAGES = 20;

/**
 * The internal OCSO agent loop (docs/12 §5): authenticated user → agent →
 * permission layer (registry) → application services. Same RBAC as the UI.
 */
export class InternalAgentService {
  constructor(
    private readonly db: Db,
    private readonly gateway: ModelGateway,
    private readonly registry: InternalToolRegistry,
    private readonly actions: InternalActionService,
  ) {}

  async ask(principal: Principal, threadId: string | null, text: string, sink: AgentSink, correlationId: string, signal?: AbortSignal): Promise<{ threadId: string }> {
    assertCan(principal, Permission.INTERNAL_AGENT_USE);
    const settings = await new SettingsService(this.db).deployment();
    if (!settings.internalAgentProfileId) throw validation('internal_agent_not_configured', 'A Tech Admin must choose a model profile for Ask OCSO in Settings');
    const thread = await this.thread(principal, threadId, text);
    const history = await this.history(thread);
    const actor = { principal: viaInternalAgent(principal), correlationId };
    const messages: ModelMessage[] = [...history, { role: 'user', content: [{ type: 'text', text }] }];
    const stored: StoredPart[] = [];
    const system = internalAgentInstructions(principal, settings.orgName, new Date().toISOString().slice(0, 10)).map((b, i, all) => ({
      ...b,
      ...(i === all.length - 2 ? { breakpointAfter: 'AGENT_PREFIX' as const } : {}),
    }));
    let answer = '';
    for (let step = 1; step <= MAX_STEPS; step++) {
      const res = await this.gateway.run({
        profileId: settings.internalAgentProfileId,
        purpose: 'INTERNAL_AGENT',
        system,
        messages,
        tools: this.registry.specs(principal),
        abortSignal: signal,
        context: { correlationId, userId: principal.userId, purpose: 'INTERNAL_AGENT' },
        onTextDelta: (d) => sink.text(d),
      });
      if (!res.toolCalls.length) {
        answer += res.text;
        break;
      }
      if (res.text) answer += res.text;
      messages.push({ role: 'assistant', content: [...(res.text ? [{ type: 'text' as const, text: res.text }] : []), ...res.toolCalls.map((c): ModelContentPart => ({ type: 'tool-call', toolCallId: c.toolCallId, toolName: c.toolName, input: c.input }))] });
      const results: ModelContentPart[] = [];
      for (const call of res.toolCalls) {
        sink.step(call.toolName.replaceAll('_', ' '));
        results.push({ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: await this.execute(principal, actor, thread, call.toolName, call.input, sink, stored) });
      }
      messages.push({ role: 'tool', content: results });
    }
    if (answer) stored.unshift({ type: 'text', text: answer });
    await this.db.insert(internalAgentMessages).values([
      { id: uuidv7(), threadId: thread, role: 'user', parts: [{ type: 'text', text }] },
      { id: uuidv7(), threadId: thread, role: 'assistant', parts: stored },
    ]);
    await this.db.update(internalAgentThreads).set({ updatedAt: new Date() }).where(eq(internalAgentThreads.id, thread));
    return { threadId: thread };
  }

  private async execute(principal: Principal, actor: { principal: Principal; correlationId: string }, threadId: string, name: string, rawArgs: unknown, sink: AgentSink, stored: StoredPart[]) {
    try {
      const { tool, args } = this.registry.resolve(principal, name, rawArgs);
      const settings = await new SettingsService(this.db).deployment();
      if (tool.risk === 'HIGH_WRITE' || (tool.risk === 'LOW_WRITE' && settings.internalAgentConfirmLowWrites)) {
        const action = await this.actions.propose(principal, threadId, tool, args);
        sink.action(action);
        stored.push({ type: 'action', action }, { type: 'tool', name, args, ok: true });
        return { type: 'json' as const, value: { status: 'pending_user_confirmation', actionId: action.id, description: action.description } };
      }
      const result = await tool.run({ db: this.db, principal: actor.principal, actor, now: new Date() }, args);
      if (result.links?.length) {
        sink.links(result.links);
        stored.push({ type: 'links', links: result.links });
      }
      if (result.table) {
        sink.table(result.table);
        stored.push({ type: 'table', table: result.table });
      }
      stored.push({ type: 'tool', name, args, ok: true });
      return { type: 'json' as const, value: result.data };
    } catch (err) {
      stored.push({ type: 'tool', name, args: rawArgs, ok: false });
      if (isDomainError(err) && err.category === 'authorization') {
        const text = `Not available for your role: ${name.replaceAll('_', ' ')}.`;
        sink.denied(text);
        stored.push({ type: 'denied', text });
        return { type: 'error' as const, value: 'Not permitted for this user role. Explain which role owns this instead.' };
      }
      return { type: 'error' as const, value: isDomainError(err) ? err.message : 'The tool failed' };
    }
  }

  private async thread(principal: Principal, threadId: string | null, firstMessage: string): Promise<string> {
    if (threadId) {
      const [row] = await this.db.select().from(internalAgentThreads).where(and(eq(internalAgentThreads.id, threadId), eq(internalAgentThreads.userId, principal.userId)));
      if (!row) throw notFound('thread', threadId);
      return row.id;
    }
    const id = uuidv7();
    await this.db.insert(internalAgentThreads).values({ id, userId: principal.userId, title: firstMessage.slice(0, 80) });
    return id;
  }

  private async history(threadId: string): Promise<ModelMessage[]> {
    const rows = await this.db.select().from(internalAgentMessages).where(eq(internalAgentMessages.threadId, threadId)).orderBy(desc(internalAgentMessages.createdAt)).limit(HISTORY_MESSAGES);
    return rows.reverse().flatMap((r) => {
      const text = (r.parts as StoredPart[]).filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join('\n');
      return text ? [{ role: r.role, content: [{ type: 'text' as const, text }] }] : [];
    });
  }

  async threads(principal: Principal) {
    return this.db.select().from(internalAgentThreads).where(eq(internalAgentThreads.userId, principal.userId)).orderBy(desc(internalAgentThreads.updatedAt)).limit(50);
  }

  async messages(principal: Principal, threadId: string) {
    const [thread] = await this.db.select().from(internalAgentThreads).where(and(eq(internalAgentThreads.id, threadId), eq(internalAgentThreads.userId, principal.userId)));
    if (!thread) throw notFound('thread', threadId);
    return this.db.select().from(internalAgentMessages).where(eq(internalAgentMessages.threadId, threadId)).orderBy(asc(internalAgentMessages.createdAt));
  }
}

