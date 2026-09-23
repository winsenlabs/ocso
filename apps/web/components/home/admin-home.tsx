import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { ChangesCard } from '@/components/system/changes-card';
import { SecHead } from '@/components/ui/sec-head';
import type { HomeData } from '@/lib/api/home';
import { firstName, formatCompact, formatLatency, formatNumber, formatPercent } from '@/lib/format';
import { hasPermission, type Session } from '@/lib/session';
import type { AskChip } from './ask-ocso-bar';
import { CapacityCard, ConnectionsCard } from './admin-rail';
import { AlertsTable } from './alerts-table';
import { HomeFrame } from './home-frame';
import { adminTail } from './home-copy';
import { periodLabel } from './home-model';
import { ServiceFlow } from './service-flow';

type TechHome = Extract<HomeData, { role: 'TECH' }>;

interface HealthItem {
  key: string;
  label: string;
  value: string;
  ok: boolean | null;
  href: string;
}

/** Tech Home (HOME decision 3): what needs you, a compact health strip, then incidents and capacity; never conversation content. */
export function AdminHome({ session, home, ask, now }: { session: Session; home: TechHome; ask: AskChip[] | null; now: Date }) {
  const data = home.admin;
  const { tiles, incidents, capacity, connections } = data;
  const tz = session.user.deployment.timezone;
  const region = session.user.deployment.region;
  const workers = tiles.healthyWorkers;
  const tail = adminTail({
    healthy: workers.healthy,
    minWarm: workers.minWarm,
    openIncidents: incidents.open,
    critical: incidents.critical,
    providersDegraded: connections.providers.degraded,
    mcpDegraded: connections.mcp.degraded,
  });
  const strip = [region ?? '', `${workers.healthy} worker${workers.healthy === 1 ? '' : 's'}`, `${incidents.open} open incident${incidents.open === 1 ? '' : 's'}`];
  const degraded = connections.providers.degraded + connections.mcp.degraded;
  const health: HealthItem[] = [
    { key: 'uptime', label: 'uptime 30d', value: data.uptime.ratio === null ? '—' : formatPercent(data.uptime.ratio, 2), ok: data.uptime.ratio === null ? null : data.uptime.ratio >= 0.999, href: '/system' },
    { key: 'workers', label: 'workers', value: `${workers.healthy} of ${workers.max}`, ok: workers.healthy >= workers.minWarm && workers.healthy > 0, href: '/system/workers' },
    { key: 'active', label: 'active conv', value: formatNumber(tiles.activeConversations), ok: null, href: '/system/queues' },
    { key: 'ttft', label: 'ttft p95', value: tiles.ttftP95Ms === null ? '—' : formatLatency(tiles.ttftP95Ms), ok: null, href: '/system/telemetry' },
    { key: 'tokens', label: 'tokens today', value: formatCompact(tiles.tokensToday), ok: null, href: '/system/telemetry' },
    { key: 'connections', label: 'connections', value: degraded ? `${degraded} degraded` : 'all healthy', ok: degraded === 0, href: '/connections?tab=providers' },
  ];

  return (
    <HomeFrame
      name={firstName(session.user.name)}
      tail={tail}
      strip={strip}
      ask={ask}
      needsYou={home.needsYou}
      tiles={home.tiles}
      period={periodLabel('TECH')}
      setup={home.setup}
      permissions={session.permissions}
      now={now}
      lead={<HealthStrip items={health} />}
    >
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
      {home.flow ? (
        <ServiceFlow
          flow={home.flow}
          links={{
            channels: hasPermission(session, Permission.CHANNELS_READ),
            routers: hasPermission(session, Permission.ROUTERS_READ),
            queues: hasPermission(session, Permission.QUEUES_MANAGE),
            agents: hasPermission(session, Permission.AGENTS_READ),
          }}
        />
      ) : null}
    </HomeFrame>
  );
}

/** One line of platform health: each fact links to where it is managed. */
function HealthStrip({ items }: { items: HealthItem[] }) {
  return (
    <ul className="health-strip" aria-label="Platform health">
      {items.map((h) => (
        <li key={h.key}>
          <Link href={h.href} className={h.ok === false ? 'hs-item bad' : 'hs-item'}>
            {h.ok === null ? null : <span className={h.ok ? 'okdot' : 'okdot d'} aria-hidden="true" />}
            <span className="hs-k">{h.label}</span>
            <span className="hs-v">{h.value}</span>
            {h.ok === false ? <span className="sr-only"> (needs attention)</span> : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}
