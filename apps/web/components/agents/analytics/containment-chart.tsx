import Link from 'next/link';
import { EmptyState } from '@/components/ui/empty-state';
import { LegendKey, LineChart, type LineMarker } from '@/components/ui/line-chart';
import type { AgentAnalytics } from '../data/analytics-schemas';
import { formatDay } from '../lib/labels';
import { Def } from '../shared/definition';

/** Calendar day (YYYY-MM-DD) of an instant in the deployment timezone, as the series is bucketed. */
export function dayIn(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/**
 * Contained vs escalated conversations per day with prompt activations
 * marked (design/02 "Containment and escalation · 14 days"). Plots daily
 * counts, so a day without conversations is a real zero, not a missing rate.
 */
export function ContainmentChart({ series, timeZone, analyticsHref }: { series: AgentAnalytics['series']; timeZone: string; analyticsHref?: string }) {
  const points = series.points;
  const total = points.reduce((s, p) => s + p.conversations, 0);
  const markers: LineMarker[] = [];
  let lastMarker: { at: number; text: string } | null = null;
  for (const v of series.promptVersions) {
    const at = points.findIndex((p) => p.day === dayIn(v.activatedAt, timeZone));
    if (at < 0) continue;
    markers.push({ at, color: 'var(--accent)', dashed: true });
    lastMarker = { at, text: `v${v.version} live · ${formatDay(v.activatedAt, timeZone)}` };
  }
  const first = points[0];
  const last = points[points.length - 1];
  const max = Math.max(1, ...points.map((p) => Math.max(p.contained, p.escalated)));
  return (
    <section className="ch" aria-label="Containment and escalation">
      <div className="t">
        <h3>
          <Def definition={series.definition}>Contained and escalated · {series.days} days</Def>
        </h3>
        <LegendKey color="var(--ink)" label="contained" />
        <LegendKey color="var(--warn)" label="escalated" />
        {analyticsHref ? (
          <Link className="mono-sm" style={{ marginLeft: 'auto' }} href={analyticsHref}>
            analytics →
          </Link>
        ) : null}
      </div>
      {total === 0 || !first || !last ? (
        <EmptyState size="sm" title="No conversations in this period">Daily contained and escalated conversations appear here once the agent handles traffic.</EmptyState>
      ) : (
        <>
          <LineChart
            label={`Contained and escalated conversations per day, ${first.day} to ${last.day}`}
            series={[
              { label: 'contained', color: 'var(--ink)', values: points.map((p) => p.contained) },
              { label: 'escalated', color: 'var(--warn)', values: points.map((p) => p.escalated) },
            ]}
            domain={[0, max * 1.15]}
            markers={markers}
            axis={[
              { text: formatDay(first.day, 'UTC') },
              ...(lastMarker ? [{ text: lastMarker.text, color: 'var(--accent)' }] : []),
              { text: formatDay(last.day, 'UTC') },
            ]}
          />
          <div className="foot">
            <span className="mono-sm">
              {total.toLocaleString('en')} conversations · {points.reduce((s, p) => s + p.escalated, 0).toLocaleString('en')} escalated
              {series.promptVersions.length ? ` · ${series.promptVersions.length} prompt activation${series.promptVersions.length === 1 ? '' : 's'} marked` : ''}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
