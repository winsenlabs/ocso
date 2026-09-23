import { sql } from 'drizzle-orm';
import type { Principal } from '@ocso/auth';
import type { Db } from '@ocso/db';
import { readableAgentsSql } from '../agents/access.js';
import { agentSummaries } from './agent-summaries.js';
import { csatStats, type CsatStat } from './agent-side-metrics.js';
import { conversationKpis } from './conversation-kpis.js';
import { DEFINITIONS } from './definitions.js';
import { escalationReasons, type EscalationReason } from './escalation-reasons.js';
import { correctionOpportunities } from './quality-signals.js';
import { QueueAnalyticsService, type QueueAnalyticsRow } from './queue-analytics.js';
import { int, previousWindow, windowOf } from './values.js';
import { CHANNEL_AGENT_REACH } from '../routing/reach.js';

export interface AgentCard {
  agentId: string;
  name: string;
  conversationType: string;
  status: string;
  promptVersion: number | null;
  channels: Array<{ kind: string; name: string }>;
  conversations: number;
  containmentRate: number | null;
  escalationRate: number | null;
  csat: number | null;
  csatResponses: number;
  openConversations: number;
  waitingForHuman: number;
  slaBreaches: number;
  openAlerts: number;
}

export type LeadDecision =
  | { kind: 'prompt_corrections'; agentId: string; agentName: string; open: number; staged: number }
  | { kind: 'understaffed_queue'; queueId: string; queueName: string; waiting: number; onShift: number; members: number }
  | { kind: 'escalation_spike'; agentId: string; agentName: string; escalationRate: number; previousRate: number; conversations: number };

export interface LeadHome {
  window: { from: string; to: string; days: number };
  tiles: {
    conversations: number;
    containmentRate: number | null;
    escalationRate: number | null;
    slaBreaches: number;
    csat: CsatStat;
    correctionsOpen: number;
    correctionsStaged: number;
  };
  agents: AgentCard[];
  queues: QueueAnalyticsRow[];
  decisions: LeadDecision[];
  escalationReasons: EscalationReason[];
  definitions: Record<string, string>;
}

export const SPIKE_MIN_POINTS = 0.05;
export const SPIKE_MIN_CONVERSATIONS = 20;

/**
 * Lead home (design/06 lead): 7-day tiles, agent cards, queues, decisions,
 * escalation reasons — all over the agents the lead's teams own (ADR-026).
 * Counts and labels only.
 */
export async function leadHome(db: Db, principal: Principal, now: Date, timezone: string, days = 7): Promise<LeadHome> {
  return (await leadHomeWithTrend(db, principal, now, timezone, days)).lead;
}

/** The same tile figures over the window just before (for the home's trend tiles). */
export interface LeadPrevious {
  conversations: number;
  containmentRate: number | null;
  escalationRate: number | null;
  slaBreaches: number;
  csat: number | null;
}

/** leadHome plus the previous window's tile figures (one extra CSAT query; the KPIs of the previous window are already read). */
export async function leadHomeWithTrend(db: Db, principal: Principal, now: Date, timezone: string, days = 7): Promise<{ lead: LeadHome; previous: LeadPrevious }> {
  const scope = readableAgentsSql(principal);
  const w = windowOf(null, days, now, timezone, scope);
  const [kpis, prevKpis, csat, prevCsat, summaries, reasons, corrections, queues, agents, alerts] = await Promise.all([
    conversationKpis(db, w, now),
    conversationKpis(db, previousWindow(w), now),
    csatStats(db, w),
    csatStats(db, previousWindow(w)),
    agentSummaries(db, days),
    escalationReasons(db, w, 6),
    correctionOpportunities(db, null, 200, scope),
    new QueueAnalyticsService(db, () => now).compute(principal, days),
    db.execute<{ id: string; name: string; conversation_type: string; status: string; version: number | null; channels: Array<{ kind: string; name: string }> | null }>(sql`
      SELECT a.id, a.name, a.conversation_type, a.status, pv.version,
             (SELECT json_agg(json_build_object('kind', ch.kind, 'name', ch.name) ORDER BY ch.name)
                FROM channels ch WHERE ch.id IN (SELECT reach.channel_id FROM (${CHANNEL_AGENT_REACH}) AS reach WHERE reach.agent_id = a.id)) AS channels
        FROM virtual_agents a
        LEFT JOIN prompt_versions pv ON pv.id = a.active_prompt_version_id
       ${scope ? sql`WHERE a.id IN (${scope})` : sql``}
       ORDER BY a.name`),
    db.execute<{ agent_id: string; n: number }>(sql`
      SELECT context ->> 'agentId' AS agent_id, count(*)::int AS n FROM alerts
       WHERE status IN ('OPEN', 'ACKNOWLEDGED') AND context ? 'agentId' GROUP BY 1`),
  ]);
  const alertsBy = new Map(alerts.rows.map((r) => [r.agent_id, int(r.n)]));
  const cards: AgentCard[] = agents.rows.map((a) => {
    const s = summaries.get(a.id);
    return {
      agentId: a.id,
      name: a.name,
      conversationType: a.conversation_type,
      status: a.status,
      promptVersion: a.version,
      channels: a.channels ?? [],
      conversations: s?.conversations ?? 0,
      containmentRate: s?.containmentRate ?? null,
      escalationRate: s?.escalationRate ?? null,
      csat: s?.csat ?? null,
      csatResponses: s?.csatResponses ?? 0,
      openConversations: s?.openConversations ?? 0,
      waitingForHuman: s?.waitingForHuman ?? 0,
      slaBreaches: kpis.byAgent.get(a.id)?.slaBreaches ?? 0,
      openAlerts: alertsBy.get(a.id) ?? 0,
    };
  });

  const decisions: LeadDecision[] = [];
  const byAgent = new Map<string, { name: string; open: number; staged: number }>();
  for (const c of corrections.items) {
    const entry = byAgent.get(c.agentId) ?? { name: c.agentName, open: 0, staged: 0 };
    if (c.status === 'OPEN') entry.open++;
    else entry.staged++;
    byAgent.set(c.agentId, entry);
  }
  for (const [agentId, e] of byAgent) decisions.push({ kind: 'prompt_corrections', agentId, agentName: e.name, open: e.open, staged: e.staged });
  for (const q of queues.queues.filter((q) => q.state === 'understaffed')) {
    decisions.push({ kind: 'understaffed_queue', queueId: q.queueId, queueName: q.name, waiting: q.waiting, onShift: q.onShift, members: q.members });
  }
  for (const a of agents.rows) {
    const cur = kpis.byAgent.get(a.id);
    const prev = prevKpis.byAgent.get(a.id);
    if (!cur || !prev || cur.conversations < SPIKE_MIN_CONVERSATIONS || prev.conversations < SPIKE_MIN_CONVERSATIONS) continue;
    if ((cur.escalationRate ?? 0) - (prev.escalationRate ?? 0) >= SPIKE_MIN_POINTS) {
      decisions.push({ kind: 'escalation_spike', agentId: a.id, agentName: a.name, escalationRate: cur.escalationRate ?? 0, previousRate: prev.escalationRate ?? 0, conversations: cur.conversations });
    }
  }

  const k = kpis.total;
  const p = prevKpis.total;
  const previous: LeadPrevious = { conversations: p.conversations, containmentRate: p.containmentRate, escalationRate: p.escalationRate, slaBreaches: p.slaBreaches, csat: prevCsat.total.average };
  const lead: LeadHome = {
    window: { from: w.from.toISOString(), to: w.to.toISOString(), days },
    tiles: {
      conversations: k.conversations,
      containmentRate: k.containmentRate,
      escalationRate: k.escalationRate,
      slaBreaches: k.slaBreaches,
      csat: csat.total,
      correctionsOpen: corrections.open,
      correctionsStaged: corrections.staged,
    },
    agents: cards,
    queues: queues.queues,
    decisions,
    escalationReasons: reasons.reasons,
    definitions: {
      containmentRate: DEFINITIONS.containment,
      escalationRate: DEFINITIONS.escalation,
      slaBreaches: DEFINITIONS.slaBreaches,
      csat: DEFINITIONS.csat,
      queueState: DEFINITIONS.queueState,
      escalationSpike: DEFINITIONS.escalationSpike,
      agentCards: 'Agent card KPIs come from agentSummaries (same containment/escalation/CSAT formulas over the last 7 days).',
    },
  };
  return { lead, previous };
}
