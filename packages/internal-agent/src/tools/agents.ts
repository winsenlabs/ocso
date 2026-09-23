import { Permission } from '@ocso/auth';
import { AgentService, agentSummaries } from '@ocso/application';
import { z } from 'zod';
import type { InternalTool } from '../contract.js';

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);

export const agentPerformance: InternalTool<{ windowDays: number }> = {
  name: 'agent_performance',
  description:
    'KPIs per virtual agent the user can see (a Lead: the agents their teams own) over a window: conversations, AI containment, escalation rate, CSAT, open and waiting conversations. Use it for "which agent escalates most" and agent comparisons. Definitions: containment = conversations without a handoff / all; escalation = conversations with a handoff / all.',
  input: z.object({ windowDays: z.number().int().min(1).max(90).default(7) }),
  permission: Permission.AGENTS_READ,
  risk: 'READ',
  async run(ctx, args) {
    // Same scope as GET /v1/agents: the user's teams' agents (ADR-026).
    const [agents, stats] = await Promise.all([new AgentService(ctx.db).list(ctx.principal), agentSummaries(ctx.db, args.windowDays)]);
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
