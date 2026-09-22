import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { ChangesCard } from '@/components/system/changes-card';
import { AlertBanner } from '@/components/ui/alert-banner';
import { SecHead } from '@/components/ui/sec-head';
import { Tile, Tiles } from '@/components/ui/tile';
import type { AdminHomeData } from '@/lib/api/home';
import { firstName, formatCompact, formatLatency, formatNumber, formatPercent, formatTime } from '@/lib/format';
import { hasPermission, type Session } from '@/lib/session';
import { CapacityCard, ConnectionsCard } from './admin-rail';
import { AlertsTable } from './alerts-table';
import { Greeting } from './greeting';
import { adminTail } from './home-copy';

/** Platform Tech Admin home (design/06): uptime, capacity, incidents, connections, privileged changes — no conversation content. */
export function AdminHome({ session, data }: { session: Session; data: AdminHomeData }) {
  const { tiles, incidents, capacity, connections } = data;
  const tz = session.user.deployment.timezone;
  const d = session.user.deployment;
  const critical = incidents.items.find((a) => a.severity === 'CRITICAL');
  const tail = adminTail({
    healthy: tiles.healthyWorkers.healthy,
    minWarm: tiles.healthyWorkers.minWarm,
    openIncidents: incidents.open,
    critical: incidents.critical,
    providersDegraded: connections.providers.degraded,
    mcpDegraded: connections.mcp.degraded,
  });
  const strip = [
    'Single-tenant',
    d.region ?? 'region not set',
    d.label,
    `${tiles.healthyWorkers.healthy} worker${tiles.healthyWorkers.healthy === 1 ? '' : 's'}`,
    `${incidents.open} open incident${incidents.open === 1 ? '' : 's'}`,
  ];

  return (
    <>
      <Greeting name={firstName(session.user.name)} tail={tail} strip={strip} />
      <Tiles>
        <Tile label="uptime 30d" value={data.uptime.ratio === null ? null : formatPercent(data.uptime.ratio, 2)} />
        <Tile
          label="healthy workers"
          value={`${tiles.healthyWorkers.healthy} of ${tiles.healthyWorkers.max}`}
          {...(tiles.healthyWorkers.healthy < tiles.healthyWorkers.minWarm ? { tone: 'warn' as const } : {})}
        />
        <Tile label="active conversations" value={formatNumber(tiles.activeConversations)} />
        <Tile label="ttft p95" value={tiles.ttftP95Ms === null ? null : formatLatency(tiles.ttftP95Ms)} />
        <Tile label="tokens today" value={formatCompact(tiles.tokensToday)} />
        <Tile label="open incidents" value={formatNumber(tiles.openIncidents)} {...(tiles.openIncidents > 0 ? { tone: 'warn' as const } : {})} />
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
          opened {formatTime(critical.openedAt, tz)}
          {critical.value ? ` · ${critical.value}` : ''} · {critical.source}
          {critical.occurrences > 1 ? ` · seen ${critical.occurrences}×` : ''}
        </AlertBanner>
      ) : null}

      <div className="row2">
        <div>
          <SecHead
            title="Open incidents and alerts"
            count={`${incidents.critical} critical · ${incidents.open} open`}
            actions={
              <Link className="btn tiny ghost" href="/alerts">
                All alerts
              </Link>
            }
          />
          <AlertsTable rows={incidents.items} />
        </div>
        <div className="rail">
          <CapacityCard capacity={capacity} />
          <ConnectionsCard connections={connections} />
          <ChangesCard changes={data.recentChanges} timeZone={tz} canAudit={hasPermission(session, Permission.AUDIT_READ)} />
        </div>
      </div>
    </>
  );
}
