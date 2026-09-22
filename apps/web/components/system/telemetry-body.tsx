import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { SecHead } from '@/components/ui/sec-head';
import { Tile, Tiles } from '@/components/ui/tile';
import { loadLatency, loadProviderHealth, loadTelemetryOverview, loadUsage } from '@/lib/api/telemetry';
import { formatCompact, formatLatency, formatNumber, formatPercent } from '@/lib/format';
import { hasPermission, requireSession } from '@/lib/session';
import { LatencyCard } from './latency-card';
import { LiveRefresh } from './live-refresh';
import { ProfileUsageTable, ProviderUsageTable, SlowTurnsTable } from './telemetry-tables';
import { UsageCard } from './usage-card';

export const WINDOWS = [60, 180, 360] as const;

/** ?minutes= → a supported latency window (the API accepts 5–360). */
export function windowOf(raw: string | undefined): (typeof WINDOWS)[number] {
  const value = Number(raw);
  return WINDOWS.find((w) => w === value) ?? 60;
}

/** /system/telemetry: latency (p95 turn, TTFT), slowest traces, and token / prompt-cache usage by profile and provider. */
export async function TelemetryBody({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, params] = await Promise.all([requireSession(), searchParams]);
  if (!hasPermission(session, Permission.TELEMETRY_TECHNICAL_READ)) return <NotPermitted role={session.roleLabel} />;
  const minutes = windowOf(typeof params['minutes'] === 'string' ? params['minutes'] : undefined);
  const tz = session.user.deployment.timezone;
  const [overview, latency, usage, providers] = await Promise.all([loadTelemetryOverview(), loadLatency(minutes), loadUsage(), loadProviderHealth()]);
  const t = overview.tiles;
  const turns = latency.points.reduce((s, p) => s + p.turns, 0);
  const fallbacks = latency.points.reduce((s, p) => s + p.fallbacks, 0);

  return (
    <>
      <div className="rowsplit" style={{ marginBottom: 10 }}>
        <div role="group" aria-label="Latency window" style={{ display: 'flex', gap: 5 }}>
          {WINDOWS.map((w) => (
            <Link key={w} className={w === minutes ? 'fchip active' : 'fchip'} aria-current={w === minutes ? 'true' : undefined} href={`/system/telemetry?minutes=${w}`} scroll={false}>
              {w === 60 ? 'Last 1h' : `Last ${w / 60}h`}
            </Link>
          ))}
        </div>
        <span className="sp" />
        <LiveRefresh pollSeconds={30} />
      </div>

      <Tiles min={126}>
        <Tile label="turn latency p95 · 1h" value={t.turnLatencyP95Ms === null ? null : formatLatency(t.turnLatencyP95Ms)} />
        <Tile label="ttft p95 · 1h" value={t.ttftP95Ms === null ? null : formatLatency(t.ttftP95Ms)} />
        <Tile label="requests / min · 1h" value={formatNumber(t.requestsPerMinute, t.requestsPerMinute < 10 ? 1 : 0)} />
        <Tile label="provider error rate · 1h" value={t.providerErrorRate === null ? null : formatPercent(t.providerErrorRate)} />
        <Tile label="tokens today" value={formatCompact(t.tokensToday)} />
        <Tile label="cache hit · input today" value={usage.totals.cachedInputShare === null ? null : formatPercent(usage.totals.cachedInputShare)} />
        <Tile label="cache read tokens today" value={usage.totals.cacheReadTokens === null ? null : formatCompact(usage.totals.cacheReadTokens)} />
        <Tile label={`turns · fallbacks · ${minutes / 60}h`} value={`${formatNumber(turns)} · ${formatNumber(fallbacks)}`} />
      </Tiles>

      <div className="row2" style={{ marginBottom: 14 }}>
        <LatencyCard series={latency} timeZone={tz} />
        <UsageCard usage={usage} />
      </div>

      <SecHead
        title="Slowest turns"
        count={latency.slowestTurns.length}
        desc={latency.traceUrlTemplate ? 'traces open in the configured viewer' : 'set OCSO_TRACE_URL_TEMPLATE to link traces'}
      />
      <SlowTurnsTable series={latency} timeZone={tz} />

      <SecHead title="Usage by model profile · today" count={usage.byProfile.length} desc="cached share counts only requests whose provider reports cache reads" style={{ marginTop: 18 }} />
      <ProfileUsageTable usage={usage} />

      <SecHead title="Usage by provider" count={providers.length} desc="cache read share is observed per provider, never assumed" style={{ marginTop: 18 }} />
      <ProviderUsageTable providers={providers} />
      <p className="mono-sm" style={{ marginTop: 10 }}>
        p50 latency and a breakdown by request purpose are not reported by the telemetry API yet; p95 and per-profile/per-provider figures are shown instead.
      </p>
    </>
  );
}
