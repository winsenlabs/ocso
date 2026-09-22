import { Permission } from '@ocso/auth';
import { eq } from 'drizzle-orm';
import { AgentService, agentSummaries } from '@ocso/application';
import { virtualAgents } from '@ocso/db';
import { z } from 'zod';
import type { InternalTool } from '../contract.js';

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);

export const agentPerformance: InternalTool<{ windowDays: number }> = {
  name: 'agent_performance',
  description:
    'KPIs per virtual agent over a window: conversations, AI containment, escalation rate, CSAT, open and waiting conversations. Use it for "which agent escalates most" and agent comparisons. Definitions: containment = conversations without a handoff / all; escalation = conversations with a handoff / all.',
  input: z.object({ windowDays: z.number().int().min(1).max(90).default(7) }),
  permission: Permission.AGENTS_READ,
  risk: 'READ',
  async run(ctx, args) {
    const [agents, stats] = await Promise.all([new AgentService(ctx.db).list(), agentSummaries(ctx.db, args.windowDays)]);
    const rows = agents
      .map((a) => ({ agent: a, s: stats.get(a.id) }))
      .sort((x, y) => (y.s?.escalationRate ?? -1) - (x.s?.escalationRate ?? -1));
    return {
      data: rows.map(({ agent, s }) => ({ id: agent.id, name: agent.name, status: agent.status, type: agent.conversationType, ...s })),
      table: {
        columns: ['Agent', 'Convs', 'Contained', 'Escalation', 'CSAT'],
        rows: rows.map(({ agent, s }) => [agent.name, s?.conversations ?? 0, pct(s?.containmentRate ?? null), pct(s?.escalationRate ?? null), s?.csat?.toFixed(2) ?? '—']),
      },
      links: rows.slice(0, 3).map(({ agent, s }) => ({
        label: `${agent.name} · ${agent.conversationType.toLowerCase()}`,
        detail: `escalation ${pct(s?.escalationRate ?? null)} · containment ${pct(s?.containmentRate ?? null)}`,
        href: `/agents/${agent.id}`,
        status: (s?.escalationRate ?? 0) > 0.25 ? 'warn' : 'ok',
      })),
    };
  },
};

export const setAgentStatus: InternalTool<{ agentId: string; status: 'LIVE' | 'PAUSED' }> = {
  name: 'set_agent_status',
  description: 'Pause a virtual agent or put it live. Sensitive: requires the user to confirm.',
  input: z.object({ agentId: z.uuid(), status: z.enum(['LIVE', 'PAUSED']) }),
  permission: Permission.AGENTS_MANAGE,
  risk: 'HIGH_WRITE',
  describe: (a) => `${a.status === 'PAUSED' ? 'Pause' : 'Put live'} virtual agent ${a.agentId}. ${a.status === 'PAUSED' ? 'New customer messages will wait for humans.' : ''}`,
  async preview(ctx, args) {
    const [agent] = await ctx.db.select({ name: virtualAgents.name, status: virtualAgents.status }).from(virtualAgents).where(eq(virtualAgents.id, args.agentId));
    if (!agent) return { changes: [] };
    return {
      summary: `${args.status === 'PAUSED' ? `Pause ${agent.name}. New customer messages will wait for humans.` : `Put ${agent.name} live.`}`,
      changes: [{ label: `${agent.name} · status`, before: agent.status, after: args.status }],
    };
  },
  async run(ctx, args) {
    const agent = await new AgentService(ctx.db).setStatus(ctx.actor, args.agentId, args.status);
    return { data: { id: agent.id, name: agent.name, status: agent.status }, links: [{ label: agent.name, detail: `status ${agent.status}`, href: `/agents/${agent.id}` }] };
  },
};
