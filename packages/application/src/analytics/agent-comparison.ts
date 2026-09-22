import { sql } from 'drizzle-orm';
import { Permission, assertCan, type Principal } from '@ocso/auth';
import type { Db, DbOrTx } from '@ocso/db';
import { readableAgentsSql } from '../agents/access.js';
import { SettingsService } from '../settings/settings.js';
import { costPer } from './agent-analytics.js';
import { costStats, csatStats, toolFailureStats } from './agent-side-metrics.js';
import { conversationKpis, emptyKpis } from './conversation-kpis.js';
import { DEFINITIONS } from './definitions.js';
import { cohortWhere, int, windowOf, type AnalyticsWindow } from './values.js';

export interface AgentComparisonRow {
  agentId: string;
  name: string;
  conversationType: string;
  status: string;
  conversations: number;
  containmentRate: number | null;
  escalated: number;
  escalationRate: number | null;
  resolutionRate: number | null;
  slaBreaches: number;
  firstResponseAiMedianSeconds: number | null;
  csat: number | null;
  csatResponses: number;
  toolFailureRate: number | null;
  costPerConversationMicros: number | null;
  currency: string | null;
  topEscalationReason: string | null;
}

export interface AgentComparison {
  window: { from: string; to: string; days: number };
  agents: AgentComparisonRow[];
  /** "Which agent is escalating the most": escalated conversations, then rate. */
  escalationRanking: Array<Pick<AgentComparisonRow, 'agentId' | 'name' | 'escalated' | 'escalationRate' | 'conversations' | 'topEscalationReason'>>;
  definitions: Record<string, string>;
}

/** Most frequent escalation reason_code per agent over the cohort. */
async function topReasons(db: DbOrTx, w: AnalyticsWindow): Promise<Map<string, string>> {
  const { rows } = await db.execute<{ agent_id: string; reason: string }>(sql`
    SELECT c.agent_id, mode() WITHIN GROUP (ORDER BY h.reason_code) AS reason
      FROM conversations c
      JOIN handoffs h ON h.conversation_id = c.id AND h.trigger <> 'HUMAN_REQUEST'
     WHERE ${cohortWhere(w)}
     GROUP BY c.agent_id`);
  return new Map(rows.map((r) => [r.agent_id, r.reason]));
}

/**
 * Agent-by-agent KPIs with the same formulas as the single-agent view (docs/11
 * §3 "agent-by-agent trends"), over the agents the principal can read (a CS
 * Lead's teams' agents, ADR-026).
 */
export async function agentComparison(db: Db, principal: Principal, days: number, now: Date = new Date()): Promise<AgentComparison> {
  assertCan(principal, Permission.ANALYTICS_BUSINESS_READ);
  const { timezone } = await new SettingsService(db).deployment();
  const scope = readableAgentsSql(principal);
  const w = windowOf(null, days, now, timezone, scope);
  const [agents, kpis, csat, cost, tools, reasons] = await Promise.all([
    db.execute<{ id: string; name: string; conversation_type: string; status: string }>(
      sql`SELECT id, name, conversation_type, status FROM virtual_agents ${scope ? sql`WHERE id IN (${scope})` : sql``} ORDER BY name`,
    ),
    conversationKpis(db, w, now),
    csatStats(db, w),
    costStats(db, w),
    toolFailureStats(db, w),
    topReasons(db, w),
  ]);
  const rows: AgentComparisonRow[] = agents.rows.map((a) => {
    const k = kpis.byAgent.get(a.id) ?? emptyKpis(a.id);
    const s = csat.byAgent.get(a.id);
    const c = costPer(cost.byAgent.get(a.id) ?? { costMicros: null, currency: null, cachedInputShare: null }, k);
    return {
      agentId: a.id,
      name: a.name,
      conversationType: a.conversation_type,
      status: a.status,
      conversations: k.conversations,
      containmentRate: k.containmentRate,
      escalated: k.escalated,
      escalationRate: k.escalationRate,
      resolutionRate: k.resolutionRate,
      slaBreaches: k.slaBreaches,
      firstResponseAiMedianSeconds: k.firstResponseAiMedianSeconds,
      csat: s?.average ?? null,
      csatResponses: int(s?.responses),
      toolFailureRate: tools.byAgent.get(a.id)?.failureRate ?? null,
      costPerConversationMicros: c.valueMicros,
      currency: c.currency,
      topEscalationReason: reasons.get(a.id) ?? null,
    };
  });
  const escalationRanking = rows
    .filter((r) => r.escalated > 0)
    .sort((x, y) => y.escalated - x.escalated || (y.escalationRate ?? 0) - (x.escalationRate ?? 0))
    .map(({ agentId, name, escalated, escalationRate, conversations, topEscalationReason }) => ({ agentId, name, escalated, escalationRate, conversations, topEscalationReason }));
  return {
    window: { from: w.from.toISOString(), to: w.to.toISOString(), days },
    agents: rows,
    escalationRanking,
    definitions: {
      containmentRate: DEFINITIONS.containment,
      escalationRate: DEFINITIONS.escalation,
      resolutionRate: DEFINITIONS.resolution,
      slaBreaches: DEFINITIONS.slaBreaches,
      firstResponseAiMedianSeconds: DEFINITIONS.firstResponseAi,
      csat: DEFINITIONS.csat,
      toolFailureRate: DEFINITIONS.toolFailure,
      costPerConversationMicros: DEFINITIONS.costPerConversation,
    },
  };
}
