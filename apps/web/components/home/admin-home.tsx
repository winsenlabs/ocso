import Link from 'next/link';
import { AlertBanner } from '@/components/ui/alert-banner';
import { SecHead } from '@/components/ui/sec-head';
import { Tile, Tiles } from '@/components/ui/tile';
import { loadOpenAlerts } from '@/lib/api/alerts';
import { getWorkerSettings } from '@/lib/api/settings';
import { loadAdminMetrics, loadCapacityNow, loadConnectionsSummary, loadPrivilegedChanges } from '@/lib/api/system';
import { firstName, formatCompact, formatLatency, formatNumber, formatPercent } from '@/lib/format';
import type { Session } from '@/lib/session';
import { AlertsTable } from './alerts-table';
import { CapacityCard, ConnectionsCard, PrivilegedChangesCard } from './admin-rail';
import { Greeting } from './greeting';

/** Platform Tech Admin home (design/06): capacity, incidents, connections, privileged changes. */
export async function AdminHome({ session, facts }: { session: Session; facts: string[] }) {
  const [metrics, alerts, workers, capacity, connections, changes] = await Promise.all([
    loadAdminMetrics(),
    loadOpenAlerts(),
    getWorkerSettings().catch(() => null),
    loadCapacityNow(),
    loadConnectionsSummary(),
    loadPrivilegedChanges(),
  ]);
  const critical = alerts?.find((a) => a.severity === 'critical' && a.state !== 'resolved');
  const tail = metrics ? 'here is the runtime right now.' : 'runtime telemetry appears here once workers report.';

  return (
    <>
      <Greeting name={firstName(session.user.name)} tail={tail} strip={facts} />
      <Tiles>
        <Tile label="uptime 30d" value={metrics ? formatPercent(metrics.uptime30d, 2) : null} />
        <Tile label="healthy workers" value={metrics ? `${metrics.healthyWorkers} of ${metrics.totalWorkers}` : null} />
        <Tile label="active conversations" value={metrics ? formatNumber(metrics.activeConversations) : null} />
        <Tile label="ttft p95" value={metrics ? formatLatency(metrics.ttftP95Ms) : null} />
        <Tile label="tokens today" value={metrics ? formatCompact(metrics.tokensToday) : null} />
        <Tile label="open incidents" value={metrics ? formatNumber(metrics.openIncidents) : null} {...(metrics && metrics.openIncidents > 0 ? { tone: 'warn' as const } : {})} />
      </Tiles>

      {critical ? (
        <AlertBanner
          tone="error"
          title={critical.title}
          action={
            <Link className="btn tiny" href="/system">
              Open control center
            </Link>
          }
        >
          {critical.detail}
        </AlertBanner>
      ) : null}

      <div className="row2">
        <div>
          <SecHead title="Open incidents and alerts" count={alerts ? alerts.length : 'no data yet'} />
          <AlertsTable rows={alerts} />
        </div>
        <div className="rail">
          <CapacityCard workers={workers} capacity={capacity} />
          <ConnectionsCard summary={connections} />
          <PrivilegedChangesCard changes={changes} timeZone={session.user.deployment.timezone} />
        </div>
      </div>
    </>
  );
}
