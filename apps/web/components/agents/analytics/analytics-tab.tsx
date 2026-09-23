import Link from 'next/link';
import { EmptyState } from '@/components/ui/empty-state';
import { HBarChart } from '@/components/ui/hbar-chart';
import { ChartCard } from '@/components/ui/rail-card';
import { getAgentAnalytics, getAgentComparison, optional } from '@/lib/api/agents';
import { formatDuration, formatNumber, formatPercent } from '@/lib/format';
import type { AgentAnalytics } from '../data/analytics-schemas';
import type { Query } from '../detail/agent-detail';
import type { AgentPageData } from '../detail/load';
import { humanizeCode } from '../lib/labels';
import { formatMoneyMicros, shares } from '../lib/metrics';
import { ANALYTICS_WINDOWS, agentHref, analyticsDays, param } from '../lib/tabs';
import { Def, Definitions } from '../shared/definition';
import { ComparisonTable } from './comparison-table';
import { ContainmentChart } from './containment-chart';
import { KpiTiles } from './metric-tiles';

/** Analytics tab (design/02): KPIs over a chosen window, channels, handling time, outcomes and agent comparison. */
export async function AnalyticsTab({ data, query }: { data: AgentPageData; query: Query }) {
  const { agent } = data;
  const days = analyticsDays(param(query, 'days'));
  const [a, comparison] = await Promise.all([optional(getAgentAnalytics(agent.id, days)), optional(getAgentComparison(days))]);
  if (!a) return <EmptyState title="Analytics are not available for your role">Business analytics are available to Leads.</EmptyState>;
  const channelShares = shares(a.channels.items, (c) => c.conversations);
  const buckets = a.handlingTime.buckets;
  const bucketShares = shares(buckets, (b) => b.total);
  const outcomes = Object.entries(a.outcomes.outcomes).sort(([, x], [, y]) => y - x);
  const outcomeShares = shares(outcomes, ([, n]) => n);

  return (
    <>
      <div className="rowsplit" style={{ marginBottom: 12 }} role="group" aria-label="Analytics window">
        {ANALYTICS_WINDOWS.map((d) => (
          <Link key={d} className={d === days ? 'btn tiny accent' : 'btn tiny'} aria-current={d === days ? 'true' : undefined} href={agentHref(agent.id, { tab: 'analytics', days: d })}>
            Last {d} days
          </Link>
        ))}
        <span className="sp" />
        <span className="mono-sm">times in {a.window.timezone} · deltas vs the previous {days} days</span>
      </div>
      <KpiTiles tiles={a.tiles} />

      <div className="g g2" style={{ marginBottom: 14 }}>
        <ChartCard title="Volume by channel">
          {a.channels.items.length ? (
            <HBarChart
              label="Conversations by channel"
              rows={a.channels.items.map((c, i) => ({
                label: `${c.name ?? humanizeCode(c.kind ?? 'unknown')} · ${formatPercent(c.containmentRate)} contained`,
                share: channelShares[i] ?? 0,
                display: formatNumber(c.conversations),
              }))}
            />
          ) : (
            <EmptyState size="sm" title="No conversations in this window" />
          )}
          <div className="foot">
            <span className="mono-sm">
              <Def definition={a.channels.definition}>containment and CSAT per channel</Def>
            </span>
          </div>
        </ChartCard>
        <ChartCard title="Handling time distribution">
          <HBarChart
            label="Resolved conversations by handling time"
            columns="minmax(70px,1fr) minmax(0,2fr) 90px"
            rows={buckets.map((b, i) => ({ label: b.bucket, share: bucketShares[i] ?? 0, display: `${formatNumber(b.total)} (${b.human} human)`, tone: b.bucket === '>30m' ? 'w' : 'default' }))}
          />
          <div className="foot">
            <span className="mono-sm">
              <Def definition={a.handlingTime.definition}>
                human-handled median {formatDuration(a.handlingTime.humanMedianSeconds)} · AI median {formatDuration(a.handlingTime.aiMedianSeconds)}
              </Def>
            </span>
          </div>
        </ChartCard>
      </div>

      <div className="g g4" style={{ marginBottom: 14 }}>
        <BigNumber title="Containment" value={formatPercent(a.tiles.containmentRate.value)} foot={`${formatNumber(a.tiles.conversations.value)} conversations`} definition={a.tiles.containmentRate.definition} />
        <BigNumber title="Time to resolution" value={formatDuration(a.timeToResolution.medianSeconds)} foot="median · resolved conversations" definition={a.timeToResolution.definition} />
        <BigNumber title="Reopen rate" value={formatPercent(a.reopenRate.value)} foot={`${a.reopenRate.reopened} of ${a.reopenRate.resolvedEver} resolved`} definition={a.reopenRate.definition} />
        <BigNumber
          title="Cost per conversation"
          value={formatMoneyMicros(a.costPerConversation.valueMicros, a.costPerConversation.currency)}
          foot={`model cost · ${a.costPerConversation.cachedInputShare === null ? 'no cache data' : `${formatPercent(a.costPerConversation.cachedInputShare, 0)} cached input`}`}
          definition={a.costPerConversation.definition}
        />
      </div>

      <div className="row2" style={{ marginBottom: 14 }}>
        <ContainmentChart series={a.series} timeZone={a.window.timezone} />
        <ChartCard title="Outcomes" meta={<span className="mono-sm">{formatPercent(a.outcomes.coverage)} analyzed</span>}>
          {outcomes.length ? (
            <HBarChart label="Conversation outcomes" rows={outcomes.map(([k, n], i) => ({ label: humanizeCode(k), share: outcomeShares[i] ?? 0, display: formatNumber(n) }))} />
          ) : (
            <EmptyState size="sm" title="No analyzed conversations">Outcomes come from the conversation classifier once conversations close.</EmptyState>
          )}
          <SalesOutcomes a={a} />
        </ChartCard>
      </div>

      {comparison ? <ComparisonTable comparison={comparison} agentId={agent.id} /> : null}
      <Definitions
        items={[
          { label: 'handling time', definition: a.handlingTime.definition },
          { label: 'time to resolution', definition: a.timeToResolution.definition },
          { label: 'reopen rate', definition: a.reopenRate.definition },
          { label: 'cost per conversation', definition: a.costPerConversation.definition },
          { label: 'outcomes · topics', definition: a.outcomes.definition },
          ...Object.entries(comparison?.definitions ?? {}).map(([k, v]) => ({ label: humanizeCode(k).toLowerCase(), definition: v })),
        ]}
      />
    </>
  );
}

function BigNumber({ title, value, foot, definition }: { title: string; value: string; foot: string; definition: string }) {
  return (
    <section className="ch" aria-label={title}>
      <div className="t">
        <h3>
          <Def definition={definition}>{title}</Def>
        </h3>
      </div>
      <div className="big">{value}</div>
      <div className="foot">
        <span className="mono-sm">{foot}</span>
      </div>
    </section>
  );
}

function SalesOutcomes({ a }: { a: AgentAnalytics }) {
  if (!a.salesOutcomes?.items.length) return null;
  return (
    <div className="foot" style={{ display: 'grid', gap: 4 }}>
      <span className="mono-sm">
        <Def definition={a.salesOutcomes.definition}>sales outcomes</Def>:{' '}
        {a.salesOutcomes.items.map((s) => `${humanizeCode(s.outcome)} ${formatNumber(s.count)}`).join(' · ')}
      </span>
    </div>
  );
}
