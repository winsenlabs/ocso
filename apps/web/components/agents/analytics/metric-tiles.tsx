import type { ReactNode } from 'react';
import { formatDuration, formatNumber } from '@/lib/format';
import type { AgentAnalytics } from '../data/analytics-schemas';
import { absoluteDelta, pointDelta, rate, relativeDelta } from '../lib/metrics';
import { Def } from '../shared/definition';

interface MetricTileProps {
  label: string;
  definition?: string | undefined;
  /** null: no data in the window (never shown as zero). */
  value: ReactNode | null;
  delta?: string | null | undefined;
  tone?: 'warn' | undefined;
}

/** Metric tile (.tile) whose label explains its formula on hover/focus. */
export function MetricTile({ label, definition, value, delta, tone }: MetricTileProps) {
  const empty = value === null;
  return (
    <div className={['tile', tone, empty ? 'nodata' : undefined].filter(Boolean).join(' ')}>
      <div className="v">
        {empty ? <span aria-hidden="true">—</span> : value}
        {!empty && delta ? (
          <span className="delta" title="vs the previous window of the same length">
            {delta}
          </span>
        ) : null}
      </div>
      <div className="k">
        <Def definition={definition}>{label}</Def>
      </div>
      {empty ? <div className="nd">no data yet</div> : null}
    </div>
  );
}

/** The eight KPI tiles of design/02 Overview, with deltas vs the previous same-length window. */
export function KpiTiles({ tiles }: { tiles: AgentAnalytics['tiles'] }) {
  const t = tiles;
  const csat = t.csat.value;
  return (
    <div className="tiles" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(124px,1fr))' }}>
      <MetricTile label="conversations" definition={t.conversations.definition} value={formatNumber(t.conversations.value)} delta={relativeDelta(t.conversations.value, t.conversations.previous)} />
      <MetricTile label="ai containment" definition={t.containmentRate.definition} value={t.containmentRate.value === null ? null : rate(t.containmentRate.value)} delta={pointDelta(t.containmentRate.value, t.containmentRate.previous)} />
      <MetricTile label="escalation rate" definition={t.escalationRate.definition} value={t.escalationRate.value === null ? null : rate(t.escalationRate.value)} delta={pointDelta(t.escalationRate.value, t.escalationRate.previous)} />
      <MetricTile label="resolution rate" definition={t.resolutionRate.definition} value={t.resolutionRate.value === null ? null : rate(t.resolutionRate.value)} delta={pointDelta(t.resolutionRate.value, t.resolutionRate.previous)} />
      <MetricTile
        label="first response (ai)"
        definition={t.firstResponseAiMedianSeconds.definition}
        value={t.firstResponseAiMedianSeconds.value === null ? null : formatDuration(t.firstResponseAiMedianSeconds.value)}
        delta={absoluteDelta(t.firstResponseAiMedianSeconds.value, t.firstResponseAiMedianSeconds.previous, 'seconds')}
      />
      <MetricTile label="sla breaches" definition={t.slaBreaches.definition} value={formatNumber(t.slaBreaches.value)} delta={absoluteDelta(t.slaBreaches.value, t.slaBreaches.previous)} tone={t.slaBreaches.value > 0 ? 'warn' : undefined} />
      <MetricTile label="tool failure rate" definition={t.toolFailureRate.definition} value={t.toolFailureRate.value === null ? null : rate(t.toolFailureRate.value)} delta={pointDelta(t.toolFailureRate.value, t.toolFailureRate.previous)} />
      <MetricTile
        label={`csat · ${formatNumber(csat.responses)} responses`}
        definition={t.csat.definition}
        value={csat.average === null ? null : formatNumber(csat.average, 2)}
        delta={csat.average === null ? null : 'of 5'}
      />
    </div>
  );
}
