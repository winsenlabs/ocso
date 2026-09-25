import { and, eq, gt, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { Permission, can } from '@ocso/auth';
import { AgentService, InboxService, QueueService, SettingsService, agentSummaries } from '@ocso/application';
import { mcpConnections, modelProviders, usageEvents, workers } from '@ocso/db';
import { z } from 'zod';
import type { InternalTool, ObjectLink, ToolContext } from '../contract.js';

/**
 * "What needs my attention?" — role-aware triage (docs/archive/specs/12 examples).
 * Each role gets only the items its permissions allow.
 */
export const attentionSummary: InternalTool<Record<string, never>> = {
  name: 'attention_summary',
  description: 'Role-aware list of what needs the user\'s attention right now, most urgent first, with links.',
  input: z.object({}),
  permission: Permission.INTERNAL_AGENT_USE,
  risk: 'READ',
  async run(ctx) {
    const items: Array<{ kind: string; title: string; detail: string; urgency: number; link?: ObjectLink }> = [];
    if (can(ctx.principal, Permission.CONVERSATIONS_READ)) items.push(...(await conversationItems(ctx)));
    if (can(ctx.principal, Permission.ANALYTICS_BUSINESS_READ)) items.push(...(await businessItems(ctx)));
    if (can(ctx.principal, Permission.SYSTEM_READ)) items.push(...(await platformItems(ctx)));
    items.sort((a, b) => b.urgency - a.urgency);
    return {
      data: items.map(({ link: _l, ...rest }) => rest),
      links: items.flatMap((i) => (i.link ? [i.link] : [])).slice(0, 6),
    };
  },
};

async function conversationItems(ctx: ToolContext) {
  const settings = await new SettingsService(ctx.db).deployment();
  const inbox = new InboxService(ctx.db);
  const policy = { execsCanViewAiActive: settings.execsCanViewAiActive };
  const [waiting, mine] = await Promise.all([
    inbox.list(ctx.principal, policy, { view: 'waiting', limit: 10 }),
    inbox.list(ctx.principal, policy, { view: 'mine', limit: 10 }),
  ]);
  const now = ctx.now.getTime();
  const breached = (due: string | null) => (due ? new Date(due).getTime() < now : false);
  return [
    ...waiting.items.map((c) => ({
      kind: 'waiting_for_human',
      title: `${c.customer.name ?? 'Customer'} waiting for a human`,
      detail: `${c.agent?.name ?? 'routing'} · ${c.queue?.name ?? 'no queue'}${breached(c.slaDueAt) ? ' · SLA breached' : ''}`,
      urgency: breached(c.slaDueAt) ? 100 : c.priority === 'P1' ? 80 : 60,
      link: { label: `${c.customer.name ?? 'Customer'} · ${c.displayId}`, detail: c.lastPreview ?? undefined, href: `/conversations/${c.id}`, status: breached(c.slaDueAt) ? ('danger' as const) : ('warn' as const) },
    })),
    ...mine.items
      .filter((c) => c.controlState === 'HUMAN_ACTIVE')
      .map((c) => ({
        kind: 'assigned_to_me',
        title: `${c.customer.name ?? 'Customer'} is yours`,
        detail: `${c.agent?.name ?? 'routing'}${c.slaDueAt ? ` · SLA due ${c.slaDueAt}` : ''}`,
        urgency: breached(c.slaDueAt) ? 90 : 40,
        link: { label: `${c.customer.name ?? 'Customer'} · ${c.displayId}`, href: `/conversations/${c.id}` },
      })),
  ];
}

async function businessItems(ctx: ToolContext) {
  // Agents in the user's scope only (a Lead: their teams' agents, ADR-026).
  const [stats, agents, queues] = await Promise.all([agentSummaries(ctx.db, 7), new AgentService(ctx.db).list(ctx.principal), new QueueService(ctx.db).list()]);
  const out = [];
  for (const a of agents) {
    const s = stats.get(a.id);
    if (s?.escalationRate !== null && s?.escalationRate !== undefined && s.conversations >= 10 && s.escalationRate > 0.2) {
      out.push({
        kind: 'escalation_rate',
        title: `${a.name} escalation rate ${(s.escalationRate * 100).toFixed(1)}%`,
        detail: `${s.conversations} conversations in 7 days`,
        urgency: 70,
        link: { label: `${a.name} · escalation`, detail: `${(s.escalationRate * 100).toFixed(1)}% over 7d`, href: `/agents/${a.id}`, status: 'warn' as const },
      });
    }
  }
  for (const q of queues.filter((q) => q.breaches > 0 || (q.waiting > 0 && q.onShift === 0))) {
    out.push({
      kind: 'queue',
      title: `${q.name}: ${q.breaches} SLA breaches, ${q.waiting} waiting`,
      detail: `${q.onShift} of ${q.members} on shift`,
      urgency: q.onShift === 0 ? 85 : 65,
      link: { label: q.name, detail: `${q.waiting} waiting · ${q.onShift}/${q.members} on shift`, href: '/queues', status: 'warn' as const },
    });
  }
  return out;
}

async function platformItems(ctx: ToolContext) {
  const [config, live, providers, mcp, fallbacks] = await Promise.all([
    new SettingsService(ctx.db).workers(),
    ctx.db.select().from(workers).where(and(eq(workers.status, 'HEALTHY'), gt(workers.heartbeatAt, new Date(ctx.now.getTime() - 60_000)))),
    ctx.db.select().from(modelProviders).where(inArray(modelProviders.status, ['DEGRADED', 'DOWN'])),
    ctx.db.select().from(mcpConnections).where(and(inArray(mcpConnections.status, ['DEGRADED', 'DOWN', 'AUTH_REQUIRED']), ne(mcpConnections.scope, 'USER'))),
    ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(usageEvents)
      .where(and(isNotNull(usageEvents.fallbackFromProviderId), gt(usageEvents.occurredAt, new Date(ctx.now.getTime() - 3_600_000)))),
  ]);
  const out = [];
  if (live.length < config.minWarmWorkers) {
    out.push({ kind: 'workers', title: `Only ${live.length} healthy workers (minimum ${config.minWarmWorkers})`, detail: 'turn capacity is reduced', urgency: 95, link: { label: 'Worker pool', href: '/system/workers', status: 'danger' as const } });
  }
  for (const p of providers) out.push({ kind: 'provider', title: `${p.name} is ${p.status.toLowerCase()}`, detail: p.lastError ?? '', urgency: 90, link: { label: `${p.name} · provider health`, href: '/connections?tab=providers', status: 'danger' as const } });
  for (const c of mcp) out.push({ kind: 'mcp', title: `MCP ${c.name} is ${c.status.toLowerCase().replace('_', ' ')}`, detail: c.lastError ?? '', urgency: 80, link: { label: `${c.name} · MCP`, href: '/connections?tab=mcp', status: 'warn' as const } });
  if ((fallbacks[0]?.n ?? 0) > 0) out.push({ kind: 'fallbacks', title: `${fallbacks[0]!.n} model requests fell back in the last hour`, detail: 'primary provider errors or throttling', urgency: 60 });
  return out;
}
