import Link from 'next/link';
import type { ReactNode } from 'react';
import { ChannelMark } from '@/components/ui/channel-mark';
import { EmptyState } from '@/components/ui/empty-state';
import { HBarChart } from '@/components/ui/hbar-chart';
import { LegendKey, LineChart, type LineMarker } from '@/components/ui/line-chart';
import { ChartCard } from '@/components/ui/rail-card';
import { Tiles } from '@/components/ui/tile';
import type { Overview } from '@/lib/api/analytics';
import { channelMark } from '@/components/workspace/lib/channel';
import { loadChannelKinds } from '@/lib/api/channels';
import {
  countDelta,
  dayKey,
  durationDelta,
  formatDuration,
  formatMoneyMicros,
  formatNumber,
  formatPercent,
  rateDelta,
  reasonLabels,
  scoreDelta,
  share,
  shortDay,
} from './metrics';
import { Fn, MetricTile } from './parts';
import { TopTags } from './top-tags';

type Refs = Record<string, number>;

/** The eight headline metrics of design/02 Overview, over every agent. */
export function OverviewTiles({ overview, refs }: { overview: Overview; refs: Refs }) {
  const t = overview.tiles;
  const csat = t.csat.value;
  return (
    <Tiles min={124}>
      <MetricTile label="conversations" value={formatNumber(t.conversations.value)} delta={countDelta(t.conversations.value, t.conversations.previous)} definition={t.conversations.definition} note={refs['conversations']} />
      <MetricTile label="ai containment" value={t.containmentRate.value === null ? null : formatPercent(t.containmentRate.value)} delta={rateDelta(t.containmentRate.value, t.containmentRate.previous)} definition={t.containmentRate.definition} note={refs['containmentRate']} />
      <MetricTile label="escalation rate" value={t.escalationRate.value === null ? null : formatPercent(t.escalationRate.value)} delta={rateDelta(t.escalationRate.value, t.escalationRate.previous)} definition={t.escalationRate.definition} note={refs['escalationRate']} />
      <MetricTile label="resolution rate" value={t.resolutionRate.value === null ? null : formatPercent(t.resolutionRate.value)} delta={rateDelta(t.resolutionRate.value, t.resolutionRate.previous)} definition={t.resolutionRate.definition} note={refs['resolutionRate']} />
      <MetricTile label="first response · ai" value={t.firstResponseAiMedianSeconds.value === null ? null : formatDuration(t.firstResponseAiMedianSeconds.value)} delta={durationDelta(t.firstResponseAiMedianSeconds.value, t.firstResponseAiMedianSeconds.previous)} definition={t.firstResponseAiMedianSeconds.definition} note={refs['firstResponseAiMedianSeconds']} />
      <MetricTile label="sla breaches" value={formatNumber(t.slaBreaches.value)} delta={countDelta(t.slaBreaches.value, t.slaBreaches.previous)} definition={t.slaBreaches.definition} note={refs['slaBreaches']} tone={t.slaBreaches.value > 0 ? 'warn' : undefined} />
      <MetricTile label="tool failure rate" value={t.toolFailureRate.value === null ? null : formatPercent(t.toolFailureRate.value)} delta={rateDelta(t.toolFailureRate.value, t.toolFailureRate.previous)} definition={t.toolFailureRate.definition} note={refs['toolFailureRate']} />
      <MetricTile
        label={`csat · ${formatNumber(csat.responses)} response${csat.responses === 1 ? '' : 's'}`}
        value={csat.average === null ? null : formatNumber(csat.average, 2)}
        delta={scoreDelta(csat.average, t.csat.previous.average)}
        definition={t.csat.definition}
        note={refs['csat']}
      />
    </Tiles>
  );
}

/** Daily volume/escalations with prompt activations, and the top escalation reasons. */
export function OverviewCharts({ overview, days, refs }: { overview: Overview; days: number; refs: Refs }) {
  const { points, promptVersions } = overview.series;
  const tz = overview.window.timezone;
  const index = new Map(points.map((p, i) => [p.day, i]));
  const markers: LineMarker[] = promptVersions.flatMap((v) => {
    const at = index.get(dayKey(v.activatedAt, tz) ?? '');
    return at === undefined ? [] : [{ at, color: 'var(--accent)', dashed: true }];
  });
  const any = points.some((p) => p.conversations > 0);
  const reasons = overview.escalationReasons;
  const max = Math.max(0, ...reasons.reasons.map((r) => r.count));
  const labels = reasonLabels(reasons.reasons);
  const first = points[0];
  const last = points[points.length - 1];
  return (
    <div className="row2" style={{ marginBottom: 14 }}>
      <ChartCard
        title={`Conversations and escalations · ${overview.series.days} days`}
        meta={
          <>
            <LegendKey color="var(--ink)" label="opened" />
            <LegendKey color="var(--warn)" label="escalated" />
            {markers.length ? <LegendKey color="var(--accent)" label="prompt version live" /> : null}
            <Fn n={refs['escalationRate']} />
          </>
        }
      >
        {any ? (
          <LineChart
            label={`Conversations opened and escalated per day over ${overview.series.days} days`}
            series={[
              { label: 'opened', color: 'var(--ink)', values: points.map((p) => p.conversations) },
              { label: 'escalated', color: 'var(--warn)', values: points.map((p) => p.escalated) },
            ]}
            markers={markers}
            domain={[0, Math.max(1, ...points.map((p) => p.conversations)) * 1.15]}
            {...(first && last ? { axis: [{ text: shortDay(first.day) }, { text: shortDay(last.day) }] } : {})}
          />
        ) : (
          <EmptyState size="sm" title={`No conversations in the last ${overview.series.days} days`}>
            The daily chart fills in as conversations open.
          </EmptyState>
        )}
        {promptVersions.length ? (
          <div className="foot">
            <span className="mono-sm">{promptVersions.map((v) => `${v.agentName} v${v.version} · ${shortDay(dayKey(v.activatedAt, tz) ?? '')}`).join(' · ')}</span>
          </div>
        ) : null}
      </ChartCard>
      <ChartCard
        title="Top escalation reasons"
        meta={
          <>
            <span className="mono-sm">
              {formatNumber(reasons.total)} handoff{reasons.total === 1 ? '' : 's'}
            </span>
            <Fn n={refs['escalationReasons']} />
            <Link className="mono-sm" style={{ marginLeft: 'auto' }} href={`/escalation-reasons?days=${days}`}>
              all reasons →
            </Link>
          </>
        }
      >
        {reasons.reasons.length ? (
          <HBarChart
            label="Top escalation reasons in the window"
            rows={reasons.reasons.slice(0, 6).map((r, i) => ({
              label: labels[i] ?? r.reasonCode,
              share: max ? r.count / max : 0,
              display: formatNumber(r.count),
              tone: r.trigger === 'TOOL_FAILURE' ? 'd' : r.trigger === 'CUSTOMER_REQUEST' ? 'default' : 'w',
            }))}
          />
        ) : (
          <EmptyState size="sm" title="No escalations in the window">
            Handoffs the agents, rules or customers request appear here, grouped by reason.
          </EmptyState>
        )}
      </ChartCard>
    </div>
  );
}

/** Channels, handling time, resolution/reopen/cost, classifier topics and top tags (design/02 Analytics tab). */
export function OverviewCards({ overview: o, refs, aside }: { overview: Overview; refs: Refs; aside?: ReactNode }) {
  const buckets = o.handlingTime.buckets;
  const bucketMax = Math.max(0, ...buckets.map((b) => b.total));
  const failMax = Math.max(0, ...o.failureTopics.items.map((f) => f.count));
  return (
    <>
      <div className={aside ? 'g g3' : 'g g2'} style={{ marginBottom: 14 }}>
        <ChartCard title="By channel" meta={<Fn n={refs['channels']} />}>
          {o.channels.items.length ? (
            <div className="ops-mini" role="table" aria-label="Conversations by channel">
              <div className="r h" role="row">
                <span role="columnheader">Channel</span>
                <span role="columnheader">Convs</span>
                <span role="columnheader">Contained</span>
                <span role="columnheader">CSAT</span>
              </div>
              {o.channels.items.map((c) => (
                <div className="r" role="row" key={c.channelId ?? 'none'}>
                  <span role="cell" className="ops-chan">
                    <ChanMark kind={c.kind} />
                    {c.name ?? 'No channel'}
                  </span>
                  <span role="cell" className="n">{formatNumber(c.conversations)}</span>
                  <span role="cell" className="n">{formatPercent(c.containmentRate)}</span>
                  <span role="cell" className="n">{c.csat === null ? '—' : `${formatNumber(c.csat, 2)} · n${c.csatResponses}`}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState size="sm" title="No conversations in the window" />
          )}
        </ChartCard>
        <ChartCard title="Handling time distribution" meta={<Fn n={refs['handlingTime']} />}>
          {bucketMax > 0 ? (
            <HBarChart label="Resolved conversations by handling time" columns="minmax(70px,1fr) minmax(0,2fr) 54px" rows={buckets.map((b) => ({ label: b.bucket, share: share(b.total, bucketMax), display: formatNumber(b.total), tone: b.bucket === '>30m' ? 'w' : 'default' }))} />
          ) : (
            <EmptyState size="sm" title="No resolved conversations in the window" />
          )}
          <div className="foot">
            <span className="mono-sm">
              human-handled median {formatDuration(o.handlingTime.humanMedianSeconds)} · AI median {formatDuration(o.handlingTime.aiMedianSeconds)}
            </span>
          </div>
        </ChartCard>
        {aside}
      </div>
      <div className="g g4" style={{ marginBottom: 14 }}>
        <ChartCard title="Time to resolution" meta={<Fn n={refs['timeToResolution']} />}>
          <div className="big">{formatDuration(o.timeToResolution.medianSeconds)}</div>
          <div className="foot"><span className="mono-sm">median · currently resolved</span></div>
        </ChartCard>
        <ChartCard title="Reopen rate" meta={<Fn n={refs['reopenRate']} />}>
          <div className="big">{formatPercent(o.reopenRate.value)}</div>
          <div className="foot"><span className="mono-sm">{o.reopenRate.reopened} of {o.reopenRate.resolvedEver} resolved</span></div>
        </ChartCard>
        <ChartCard title="Cost per conversation" meta={<Fn n={refs['costPerConversation']} />}>
          <div className="big">{formatMoneyMicros(o.costPerConversation.valueMicros, o.costPerConversation.currency)}</div>
          <div className="foot"><span className="mono-sm">model cost · {o.costPerConversation.cachedInputShare === null ? 'no cache data' : `${formatPercent(o.costPerConversation.cachedInputShare, 0)} cache read`}</span></div>
        </ChartCard>
        <ChartCard title="Knowledge gaps" meta={<>{o.knowledgeGaps.newCount ? <span className="schip warn">{o.knowledgeGaps.newCount} new</span> : null}<Fn n={refs['knowledgeGaps']} /></>}>
          {o.knowledgeGaps.items.length ? (
            <div className="ops-list">
              {o.knowledgeGaps.items.slice(0, 4).map((g) => (
                <div className="rowsplit" key={g.key}>
                  <span>{g.label}</span>
                  <span className="sp" />
                  <span className="mono-sm">{g.count} asks</span>
                </div>
              ))}
            </div>
          ) : (
            <span className="mono-sm">none detected in the window</span>
          )}
        </ChartCard>
      </div>
      <div className={o.failureTopics.items.length ? 'g g2' : undefined} style={{ marginBottom: 14 }}>
        {o.failureTopics.items.length ? (
          <ChartCard title="Common failure topics" meta={<Fn n={refs['failureTopics']} />}>
            <HBarChart label="Common failure topics" columns="minmax(90px,1fr) minmax(0,1.6fr) 44px" rows={o.failureTopics.items.slice(0, 6).map((f) => ({ label: f.label, share: share(f.count, failMax), display: formatNumber(f.count), tone: 'w' }))} />
          </ChartCard>
        ) : null}
        <TopTags tags={o.tags} conversations={o.tiles.conversations.value} refs={refs} />
      </div>
    </>
  );
}

/** The kind's mark from its descriptor (kinds load once per request). */
async function ChanMark({ kind }: { kind: string | null }) {
  const mark = channelMark(await loadChannelKinds(), kind);
  return mark ? <ChannelMark mark={mark} /> : null;
}
