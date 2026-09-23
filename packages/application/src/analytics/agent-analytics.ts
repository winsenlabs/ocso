import { eq } from 'drizzle-orm';
import { Permission, assertCan, type Principal } from '@ocso/auth';
import { notFound } from '@ocso/domain';
import { virtualAgents, type Db } from '@ocso/db';
import { z } from 'zod';
import { assertAgentReadable, readableAgentsSql } from '../agents/access.js';
import { SettingsService } from '../settings/settings.js';
import { csatStats, costStats, toolFailureStats, type CsatStat } from './agent-side-metrics.js';
import { channelBreakdown, handlingTime, type ChannelBreakdown, type HandlingTime } from './channel-and-handling.js';
import { conversationKpis, type ConversationKpis } from './conversation-kpis.js';
import { containmentSeries, promptVersionMarkers, type DailyPoint, type PromptVersionMarker } from './daily-series.js';
import { DEFINITIONS } from './definitions.js';
import { escalationReasons, type EscalationReason } from './escalation-reasons.js';
import { topTags, type TagCountRow } from './conversation-tags.js';
import { insightMix, knowledgeGaps, salesOutcomes, topInsightLabels, type InsightMix, type KnowledgeGap, type LabelCount, type SalesOutcomeRow } from './insight-topics.js';
import { correctionOpportunities, reviewedConversations, type CorrectionOpportunity, type ReviewedConversation } from './quality-signals.js';
import { previousWindow, ratio, windowOf } from './values.js';

export const AnalyticsQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) });
export type AnalyticsQuery = z.infer<typeof AnalyticsQuery>;

export const SERIES_DAYS = 14;
const INSIGHT_CANDIDATE_MIN = 3;

export interface Tile<T = number | null> {
  value: T;
  /** Same metric over the previous same-length window. */
  previous: T;
  definition: string;
}

export interface AgentAnalytics {
  agent: { id: string; name: string; conversationType: string; status: string } | null;
  window: { from: string; to: string; days: number; timezone: string };
  tiles: {
    conversations: Tile<number>;
    containmentRate: Tile;
    escalationRate: Tile;
    resolutionRate: Tile;
    firstResponseAiMedianSeconds: Tile;
    slaBreaches: Tile<number>;
    toolFailureRate: Tile;
    csat: Tile<CsatStat>;
  };
  series: { days: number; points: DailyPoint[]; promptVersions: PromptVersionMarker[]; definition: string };
  escalationReasons: { total: number; reasons: EscalationReason[]; definition: string };
  tags: { tagged: number; items: TagCountRow[]; definition: string };
  failureTopics: { items: LabelCount[]; definition: string };
  topics: { items: LabelCount[]; definition: string };
  knowledgeGaps: { items: KnowledgeGap[]; newCount: number; definition: string };
  outcomes: InsightMix & { coverage: number | null; definition: string };
  corrections: { open: number; staged: number; items: CorrectionOpportunity[]; insightCandidates: LabelCount[]; definition: string };
  reviews: { inWindow: number; items: ReviewedConversation[] };
  channels: { items: ChannelBreakdown[]; definition: string };
  handlingTime: HandlingTime & { definition: string };
  timeToResolution: { medianSeconds: number | null; definition: string };
  reopenRate: { value: number | null; reopened: number; resolvedEver: number; definition: string };
  costPerConversation: { valueMicros: number | null; costMicros: number | null; currency: string | null; conversations: number; cachedInputShare: number | null; definition: string };
  salesOutcomes: { items: SalesOutcomeRow[]; definition: string } | null;
}

const tile = <T>(value: T, previous: T, definition: string): Tile<T> => ({ value, previous, definition });

/**
 * Lead agent analytics (design/02 Overview + Analytics tabs). Every number
 * is a documented formula over explicit rows — no composite quality score.
 * agentId = null aggregates every agent the principal can read (a Lead's
 * teams' agents, ADR-026); another team's agent is not found.
 */
export class AgentAnalyticsService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async analytics(principal: Principal, agentId: string | null, days: number): Promise<AgentAnalytics> {
    assertCan(principal, Permission.ANALYTICS_BUSINESS_READ);
    if (agentId) await assertAgentReadable(this.db, principal, agentId);
    const agent = agentId ? await this.agent(agentId) : null;
    const now = this.now();
    const { timezone } = await new SettingsService(this.db).deployment();
    const scope = readableAgentsSql(principal);
    const w = windowOf(agentId, days, now, timezone, scope);
    const prev = previousWindow(w);
    const [kpis, prevKpis, csat, cost, tools] = await Promise.all([
      conversationKpis(this.db, w, now),
      conversationKpis(this.db, prev, now),
      csatStats(this.db, w),
      costStats(this.db, w),
      toolFailureStats(this.db, w),
    ]);
    const [prevCsat, prevTools] = await Promise.all([csatStats(this.db, prev), toolFailureStats(this.db, prev)]);
    const k = kpis.total;
    const p = prevKpis.total;
    const seriesStart = new Date(now.getTime() - SERIES_DAYS * 86_400_000);
    const [points, markers, reasons, failures, topics, gaps, mix, corrections, reviews, channels, handling, sales, tags] = await Promise.all([
      containmentSeries(this.db, agentId, SERIES_DAYS, now, timezone, scope),
      promptVersionMarkers(this.db, agentId, seriesStart, now, scope),
      escalationReasons(this.db, w),
      topInsightLabels(this.db, w, 'failure'),
      topInsightLabels(this.db, w, 'topic'),
      knowledgeGaps(this.db, w),
      insightMix(this.db, w),
      correctionOpportunities(this.db, agentId, 10, scope),
      reviewedConversations(this.db, w),
      channelBreakdown(this.db, w),
      handlingTime(this.db, w),
      !agent || agent.conversationType === 'SALES' ? salesOutcomes(this.db, w) : Promise.resolve(null),
      topTags(this.db, w),
    ]);
    return {
      agent,
      window: { from: w.from.toISOString(), to: w.to.toISOString(), days, timezone },
      tiles: {
        conversations: tile(k.conversations, p.conversations, DEFINITIONS.conversations),
        containmentRate: tile(k.containmentRate, p.containmentRate, DEFINITIONS.containment),
        escalationRate: tile(k.escalationRate, p.escalationRate, DEFINITIONS.escalation),
        resolutionRate: tile(k.resolutionRate, p.resolutionRate, DEFINITIONS.resolution),
        firstResponseAiMedianSeconds: tile(k.firstResponseAiMedianSeconds, p.firstResponseAiMedianSeconds, DEFINITIONS.firstResponseAi),
        slaBreaches: tile(k.slaBreaches, p.slaBreaches, DEFINITIONS.slaBreaches),
        toolFailureRate: tile(tools.total.failureRate, prevTools.total.failureRate, DEFINITIONS.toolFailure),
        csat: tile(csat.total, prevCsat.total, DEFINITIONS.csat),
      },
      series: { days: SERIES_DAYS, points, promptVersions: markers, definition: `${DEFINITIONS.containment} ${DEFINITIONS.escalation}` },
      escalationReasons: { ...reasons, definition: DEFINITIONS.escalationReasons },
      tags: { ...tags, definition: DEFINITIONS.tags },
      failureTopics: { items: failures, definition: DEFINITIONS.insightTopics },
      topics: { items: topics, definition: DEFINITIONS.insightTopics },
      knowledgeGaps: { items: gaps, newCount: gaps.filter((g) => g.isNew).length, definition: DEFINITIONS.knowledgeGapNew },
      outcomes: { ...mix, coverage: ratio(mix.analyzed, k.conversations), definition: DEFINITIONS.insightTopics },
      corrections: {
        ...corrections,
        insightCandidates: failures.filter((f) => f.count >= INSIGHT_CANDIDATE_MIN),
        definition: `${DEFINITIONS.corrections} ${DEFINITIONS.insightCandidates}`,
      },
      reviews,
      channels: { items: channels, definition: `${DEFINITIONS.containment} ${DEFINITIONS.csat}` },
      handlingTime: { ...handling, definition: DEFINITIONS.handlingTime },
      timeToResolution: { medianSeconds: k.timeToResolutionMedianSeconds, definition: DEFINITIONS.timeToResolution },
      reopenRate: { value: k.reopenRate, reopened: k.reopened, resolvedEver: k.resolvedEver, definition: DEFINITIONS.reopen },
      costPerConversation: costPer(cost.total, k),
      salesOutcomes: sales ? { items: sales, definition: 'conversation_insights.sales_outcome of cohort conversations of SALES agents, grouped by UPPER_SNAKE outcome code.' } : null,
    };
  }

  private async agent(agentId: string) {
    const [row] = await this.db
      .select({ id: virtualAgents.id, name: virtualAgents.name, conversationType: virtualAgents.conversationType, status: virtualAgents.status })
      .from(virtualAgents)
      .where(eq(virtualAgents.id, agentId));
    if (!row) throw notFound('agent', agentId);
    return row;
  }
}

export function costPer(cost: { costMicros: number | null; currency: string | null; cachedInputShare: number | null }, k: ConversationKpis) {
  return {
    valueMicros: cost.costMicros !== null && k.conversations > 0 ? Math.round(cost.costMicros / k.conversations) : null,
    costMicros: cost.costMicros,
    currency: cost.currency,
    conversations: k.conversations,
    cachedInputShare: cost.cachedInputShare,
    definition: DEFINITIONS.costPerConversation,
  };
}

