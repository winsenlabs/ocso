import Link from 'next/link';
import { AlertBanner } from '@/components/ui/alert-banner';
import { EmptyState } from '@/components/ui/empty-state';
import { HBarChart } from '@/components/ui/hbar-chart';
import { ChartCard } from '@/components/ui/rail-card';
import { SecHead } from '@/components/ui/sec-head';
import { StatusChip } from '@/components/ui/status-chip';
import { getAgentAnalytics, optional } from '@/lib/api/agents';
import { formatAge, formatNumber, formatPercent } from '@/lib/format';
import { ContainmentChart } from '../analytics/containment-chart';
import { KpiTiles, MetricTile } from '../analytics/metric-tiles';
import type { AgentAnalytics } from '../data/analytics-schemas';
import type { AgentPageData } from '../detail/load';
import { alertTone, componentLabel, humanizeCode } from '../lib/labels';
import { shares } from '../lib/metrics';
import { agentHref } from '../lib/tabs';
import { Def, Definitions } from '../shared/definition';
import { ReviewedTable } from './reviewed-table';

/** Overview tab (design/02): 7-day KPIs, trend, escalation reasons, insights, reviews and alerts. */
export async function OverviewTab({ data }: { data: AgentPageData }) {
  const { agent, can } = data;
  const analytics = can.analytics ? await optional(getAgentAnalytics(agent.id, 7)) : null;
  if (!analytics) return <StatsOverview data={data} />;
  const a = analytics;
  const labels = new Map(data.prompt.components.map((c) => [c.key, c.label]));
  const reasonShares = shares(a.escalationReasons.reasons, (r) => r.count);
  const failureShares = shares(a.failureTopics.items, (r) => r.count);

  return (
    <>
      <KpiTiles tiles={a.tiles} />
      <div className="row2" style={{ marginBottom: 14 }}>
        <ContainmentChart series={a.series} timeZone={a.window.timezone} analyticsHref={agentHref(agent.id, { tab: 'analytics' })} />
        <ChartCard title="Top escalation reasons" meta={<span className="mono-sm">{formatNumber(a.escalationReasons.total)} handoffs</span>}>
          {a.escalationReasons.reasons.length ? (
            <HBarChart
              label="Top escalation reasons"
              rows={a.escalationReasons.reasons.slice(0, 6).map((r, i) => ({ label: `${humanizeCode(r.reasonCode)} · ${r.trigger.toLowerCase().replace(/_/g, ' ')}`, share: reasonShares[i] ?? 0, display: formatNumber(r.count), tone: i === 0 ? 'w' : 'default' }))}
            />
          ) : (
            <EmptyState size="sm" title="No escalations in the last 7 days" />
          )}
          <div className="foot">
            <span className="mono-sm">
              <Def definition={a.escalationReasons.definition}>grouped by reason code and trigger</Def>
            </span>
          </div>
        </ChartCard>
      </div>

      <div className="g g3" style={{ marginBottom: 14 }}>
        <ChartCard title="Common failure topics">
          {a.failureTopics.items.length ? (
            <HBarChart label="Common failure topics" columns="minmax(90px,1fr) minmax(0,1.6fr) 44px" rows={a.failureTopics.items.slice(0, 5).map((f, i) => ({ label: f.label, share: failureShares[i] ?? 0, display: formatNumber(f.count), tone: 'w' }))} />
          ) : (
            <EmptyState size="sm" title="No failure topics">
              Topics appear once conversations are analyzed{a.outcomes.coverage === null ? '' : ` (${formatPercent(a.outcomes.coverage)} so far)`}.
            </EmptyState>
          )}
        </ChartCard>
        <ChartCard title="Knowledge gaps" meta={a.knowledgeGaps.newCount ? <StatusChip tone="warn">{a.knowledgeGaps.newCount} new</StatusChip> : null}>
          {a.knowledgeGaps.items.length ? (
            <div style={{ display: 'grid', gap: 7, fontSize: 12.5, color: 'var(--ink-2)' }}>
              {a.knowledgeGaps.items.slice(0, 5).map((g) => (
                <div className="rowsplit" key={g.key}>
                  <span>{g.label}</span>
                  <span className="sp" />
                  <span className="mono-sm">{g.count} asks{g.isNew ? ' · new' : ''}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState size="sm" title="No knowledge gaps found" />
          )}
        </ChartCard>
        <ChartCard title="Prompt correction opportunities" meta={<StatusChip tone="accent">{a.corrections.open + a.corrections.staged}</StatusChip>}>
          {a.corrections.items.length ? (
            <div style={{ display: 'grid', gap: 8 }}>
              {a.corrections.items.slice(0, 3).map((c) => (
                <div key={c.id} style={{ display: 'grid', gap: 2 }}>
                  <span style={{ fontSize: 12.5, color: 'var(--ink)', fontWeight: 500 }}>{c.title}</span>
                  <span className="mono-sm">
                    observed {c.occurrences}× · component: {componentLabel(c.componentKey, labels)} · {c.status.toLowerCase()}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState size="sm" title="No open corrections" />
          )}
          {can.editPrompt ? (
            <div className="foot">
              <Link className="btn tiny accent" href={agentHref(agent.id, { tab: 'prompt' })}>
                Open prompt editor
              </Link>
            </div>
          ) : null}
        </ChartCard>
      </div>

      <div className="row2">
        <div>
          <SecHead title="Latest reviewed conversations" count={`${a.reviews.inWindow} this week`} actions={can.reviews ? <Link className="btn tiny ghost" href={agentHref(agent.id, { tab: 'quality' })}>All reviews</Link> : null} />
          <ReviewedTable items={a.reviews.items} />
        </div>
        <AlertsPanel data={data} />
      </div>
      <OverviewDefinitions a={a} />
    </>
  );
}

function AlertsPanel({ data }: { data: AgentPageData }) {
  const alerts = data.alerts ?? [];
  return (
    <div>
      <SecHead title="Alerts for this agent" count={`${alerts.length} open`} actions={<Link className="btn tiny ghost" href="/alerts">All alerts</Link>} />
      {alerts.length ? (
        <div className="ch" style={{ gap: 12 }}>
          {alerts.slice(0, 5).map((al) => (
            <AlertBanner key={al.id} tone={alertTone(al.severity)} title={al.title} style={{ margin: 0 }}>
              {al.body} · opened {formatAge(al.openedAt)} ago{al.status === 'ACKNOWLEDGED' ? ' · acknowledged' : ''}
            </AlertBanner>
          ))}
        </div>
      ) : (
        <EmptyState size="sm" title="No open alerts">Alerts about this agent that your role can see appear here.</EmptyState>
      )}
    </div>
  );
}

/** Roles without business analytics: the 7-day summary every agent reader can see. */
function StatsOverview({ data }: { data: AgentPageData }) {
  const s = data.agent.stats;
  return (
    <>
      <div className="tiles" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(124px,1fr))' }}>
        <MetricTile label="conversations · 7d" value={s ? formatNumber(s.conversations) : null} />
        <MetricTile label="ai containment" value={s?.containmentRate != null ? formatPercent(s.containmentRate) : null} />
        <MetricTile label="escalation rate" value={s?.escalationRate != null ? formatPercent(s.escalationRate) : null} />
        <MetricTile label={`csat · ${s?.csatResponses ?? 0} responses`} value={s?.csat != null ? formatNumber(s.csat, 2) : null} />
        <MetricTile label="open now" value={s ? formatNumber(s.openConversations) : null} />
        <MetricTile label="waiting for a human" value={s ? formatNumber(s.waitingForHuman) : null} tone={s && s.waitingForHuman > 0 ? 'warn' : undefined} />
      </div>
      <p className="mono-sm" style={{ margin: '0 0 14px' }}>
        Trends, escalation reasons and reviews are part of business analytics (Lead).
      </p>
      <AlertsPanel data={data} />
    </>
  );
}

function OverviewDefinitions({ a }: { a: AgentAnalytics }) {
  return (
    <Definitions
      items={[
        { label: 'conversations', definition: a.tiles.conversations.definition },
        { label: 'containment', definition: a.tiles.containmentRate.definition },
        { label: 'escalation', definition: a.tiles.escalationRate.definition },
        { label: 'resolution', definition: a.tiles.resolutionRate.definition },
        { label: 'first response', definition: a.tiles.firstResponseAiMedianSeconds.definition },
        { label: 'sla breaches', definition: a.tiles.slaBreaches.definition },
        { label: 'tool failure', definition: a.tiles.toolFailureRate.definition },
        { label: 'csat', definition: a.tiles.csat.definition },
        { label: 'escalation reasons', definition: a.escalationReasons.definition },
        { label: 'topics', definition: a.failureTopics.definition },
        { label: 'knowledge gaps', definition: a.knowledgeGaps.definition },
        { label: 'corrections', definition: a.corrections.definition },
      ]}
    />
  );
}
