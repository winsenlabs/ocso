import type { TelemetryOverview } from '@/lib/api/telemetry';
import { formatDateTime, formatDuration, formatPercent } from '@/lib/format';
import { dotClass, overallTone } from './system-meta';

/**
 * Status strip (design/03 .statusbar): overall headline, one dot per service
 * with the rule that produced it, and 30-day uptime. The API has no per-day
 * uptime history, so the design's day gauge is replaced by the ratio itself.
 */
export function StatusBar({ overview, timeZone }: { overview: TelemetryOverview; timeZone: string }) {
  const { status, uptime } = overview;
  const affected = status.chips.filter((c) => c.status === 'degraded' || c.status === 'down');
  const unknown = status.chips.filter((c) => c.status === 'unknown');
  const sub = [
    `${status.healthy} of ${status.chips.length} services healthy`,
    affected.length ? affected.map((c) => `${c.label.toLowerCase()}: ${c.detail}`).join(' · ') : null,
    unknown.length ? `no signal yet: ${unknown.map((c) => c.label).join(', ')}` : null,
  ].filter(Boolean);

  return (
    <section className={`statusbar ${overallTone(status.overall)}`} aria-label="Service status">
      <div>
        <div className="big">{status.headline}</div>
        <div className="mono-sm">{sub.join(' · ')}</div>
      </div>
      <ul className="svc" aria-label="Services">
        {status.chips.map((c) => (
          <li key={c.key} title={`${c.detail} — ${c.rule}`}>
            <span className={dotClass(c.status)} aria-hidden="true" />
            {c.label}
            {c.status !== 'ok' ? <span className="sr-only">{` ${c.status}`}</span> : null}
            {c.key === 'mcp' && c.status === 'degraded' ? <span className="mono-sm">· {c.detail}</span> : null}
          </li>
        ))}
      </ul>
      <div className="uptime" title={uptime.definition}>
        <span className="mono-sm">uptime {uptime.windowDays}d</span>
        <span className="uptime-v">{uptime.ratio === null ? '—' : formatPercent(uptime.ratio, 2)}</span>
        <span className="mono-sm">
          {uptime.ratio === null
            ? 'no health samples yet'
            : uptime.lastIncidentAt
              ? `last incident ${formatDateTime(uptime.lastIncidentAt, timeZone)}`
              : `no incident · ${formatDuration(uptime.minutes * 60)} sampled`}
        </span>
      </div>
    </section>
  );
}
