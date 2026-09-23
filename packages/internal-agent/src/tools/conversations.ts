import { Permission } from '@ocso/auth';
import { InboxService, SettingsService, assertConversationAccess, loadConversationDetail } from '@ocso/application';
import { displayId } from '@ocso/domain';
import { z } from 'zod';
import type { InternalTool } from '../contract.js';

const policyOf = async (ctx: Parameters<InternalTool['run']>[0]) => {
  const s = await new SettingsService(ctx.db).deployment();
  return { execsCanViewAiActive: s.execsCanViewAiActive };
};

export const listConversations: InternalTool<{ view: 'all' | 'mine' | 'waiting' | 'ai' | 'human' | 'priority' | 'resolved'; search?: string | undefined; agentId?: string | undefined; limit: number }> = {
  name: 'list_conversations',
  description:
    'List conversations the user may see. view: all | mine (assigned to me) | waiting (waiting for a human) | ai | human | priority | resolved. Optional search text (customer name, phone, message text) and agentId.',
  input: z.object({
    view: z.enum(['all', 'mine', 'waiting', 'ai', 'human', 'priority', 'resolved']).default('all'),
    search: z.string().max(200).optional(),
    agentId: z.uuid().optional(),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  permission: Permission.CONVERSATIONS_READ,
  risk: 'READ',
  async run(ctx, args) {
    const result = await new InboxService(ctx.db).list(ctx.principal, await policyOf(ctx), {
      view: args.view,
      search: args.search,
      agentId: args.agentId,
      limit: args.limit,
    });
    return {
      data: { counts: result.counts, conversations: result.items.map((c) => ({ id: c.id, ref: c.displayId, customer: c.customer.name, agent: c.agent.name, state: c.controlState, priority: c.priority, preview: c.lastPreview, waitingSince: c.waitingSince, slaDueAt: c.slaDueAt })) },
      links: result.items.slice(0, 5).map((c) => ({
        label: `${c.displayId} · ${c.customer.name ?? 'Customer'}`,
        detail: `${c.agent.name} · ${c.controlState.replaceAll('_', ' ').toLowerCase()}${c.lastPreview ? ` · ${c.lastPreview.slice(0, 60)}` : ''}`,
        href: `/conversations/${c.id}`,
        status: c.controlState === 'WAITING_FOR_HUMAN' ? 'warn' : 'ok',
      })),
    };
  },
};

export const conversationDetail: InternalTool<{ conversationId: string }> = {
  name: 'get_conversation',
  description: 'Get one conversation: customer, agent, control state, queue, assignee, AI summary and open handoff.',
  input: z.object({ conversationId: z.uuid() }),
  permission: Permission.CONVERSATIONS_READ,
  risk: 'READ',
  async run(ctx, args) {
    await assertConversationAccess(ctx.db, ctx.principal, args.conversationId, await policyOf(ctx));
    const detail = await loadConversationDetail(ctx.db, args.conversationId);
    return {
      data: detail,
      links: detail ? [{ label: `${displayId('conv', detail.id)} · ${detail.customer.name ?? 'Customer'}`, detail: detail.summary?.text.slice(0, 120), href: `/conversations/${detail.id}` }] : [],
    };
  },
};
