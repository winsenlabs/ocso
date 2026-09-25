import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { AlertBanner } from '@/components/ui/alert-banner';
import { SecHead } from '@/components/ui/sec-head';
import { listAlerts } from '@/lib/api/alerts';
import { loadAuditStoreStatus } from '@/lib/api/audit-store';
import { listPlugins } from '@/lib/api/plugins';
import { loadStorageReport } from '@/lib/api/storage';
import { listProviderKinds } from '@/lib/api/models';
import { loadWorkerSettings } from '@/lib/api/system';
import { loadLatency, loadMcpHealth, loadPrivilegedChanges, loadProviderHealth, loadTelemetryOverview, loadUsage, loadWorkersTelemetry } from '@/lib/api/telemetry';
import { formatDuration, formatPercent, formatTime } from '@/lib/format';
import { hasPermission, requireSession } from '@/lib/session';
import { AuditStorePanel } from './audit-store-panel';
import { ChangesCard } from './changes-card';
import { LatencyCard } from './latency-card';
import { LiveRefresh } from './live-refresh';
import { McpHealthTable } from './mcp-health';
import { PluginsPanel } from './plugins-panel';
import { ProviderHealthGrid } from './provider-health';
import { QueueCard } from './queue-card';
import { StatusBar } from './status-bar';
import { StoragePanel } from './storage-panel';
import { SystemTiles } from './system-tiles';
import { UsageCard } from './usage-card';
import { WorkerConfig } from './worker-config';
import { WorkersTable } from './workers-table';

/** System control center body (design/03), from GET /v1/telemetry/* and /v1/settings/workers. */
export async function SystemOverview() {
  const session = await requireSession();
  if (!hasPermission(session, Permission.TELEMETRY_TECHNICAL_READ)) return <NotPermitted role={session.roleLabel} />;
  const tz = session.user.deployment.timezone;
  const canAlerts = hasPermission(session, Permission.ALERTS_TECHNICAL_READ);
  const canProviders = hasPermission(session, Permission.PROVIDERS_READ);
  const canAuditStore = hasPermission(session, Permission.SYSTEM_READ) || hasPermission(session, Permission.AUDIT_VERIFY);
  const canStorage = hasPermission(session, Permission.SYSTEM_READ);
  const [overview, latency, usage, workers, providers, mcp, changes, settings, critical, kinds, auditStore, storage, plugins] = await Promise.all([
    loadTelemetryOverview(),
    loadLatency(60),
    loadUsage(),
    loadWorkersTelemetry(),
    loadProviderHealth(),
    loadMcpHealth(),
    loadPrivilegedChanges(8),
    loadWorkerSettings().catch(() => null),
    canAlerts ? listAlerts({ status: 'OPEN', kind: 'TECHNICAL', severity: 'CRITICAL', limit: 1 }).then((p) => p.items[0] ?? null) : Promise.resolve(null),
    // Provider marks come from the provider definitions; without them the grid shows generic marks.
    canProviders ? listProviderKinds().catch(() => []) : Promise.resolve([]),
    // The audit store (ADR-032): never blocks the page — a failed load shows as unavailable.
    canAuditStore ? loadAuditStoreStatus().catch(() => null) : Promise.resolve(undefined),
    // Storage growth (PM/research/11 §7): daily samples; like the audit store, never blocks the page.
    canStorage ? loadStorageReport().catch(() => null) : Promise.resolve(undefined),
    // Installed and first-party plugins (docs/plugins/installing.md): system.read, never blocks the page.
    canStorage ? listPlugins().catch(() => null) : Promise.resolve(undefined),
  ]);
  const cfg = workers.config;
  const turnAge = overview.queue.turn.oldestAgeSeconds;
  const scalingOut = turnAge !== null && (turnAge > cfg.scaleOutQueueAgeSeconds || overview.queue.turn.depth > cfg.scaleOutQueueDepth);
  const starting = workers.workers.filter((w) => w.effectiveStatus === 'STARTING').length;
  const slotShare = workers.leases.slotsTotal ? workers.leases.active / workers.leases.slotsTotal : null;
  const canConfigure = hasPermission(session, Permission.SYSTEM_CONFIGURE);

  return (
    <>
      <div className="rowsplit" style={{ marginBottom: 8 }}>
        <span className="sp" />
        <LiveRefresh events={['alert.opened', 'alert.updated', 'alert.resolved', 'config.changed']} pollSeconds={20} />
      </div>
      {critical ? (
        <AlertBanner
          tone="error"
          title={critical.title}
          action={
            <Link className="btn tiny" href={`/alerts?alert=${critical.id}`}>
              Acknowledge
            </Link>
          }
        >
          {critical.body} Opened {formatTime(critical.openedAt, tz)} · {critical.source} · audience {critical.audienceRoles.map((r) => r.toLowerCase().replace(/_/g, ' ')).join(', ')}.
        </AlertBanner>
      ) : null}
      {scalingOut ? (
        <AlertBanner tone="warn" title="Queue above the scale-out threshold">
          Oldest turn waiting {formatDuration(turnAge)} against a {cfg.scaleOutQueueAgeSeconds}s target ({overview.queue.turn.depth} waiting, threshold{' '}
          {cfg.scaleOutQueueDepth}). {starting ? `${starting} worker${starting === 1 ? '' : 's'} starting. ` : ''}Cooldown {cfg.scaleInCooldownSeconds}s ·
          conversation slots {formatPercent(slotShare, 0)} used.
        </AlertBanner>
      ) : null}

      <StatusBar overview={overview} timeZone={tz} />
      <SystemTiles overview={overview} scaleOutQueueAgeSeconds={cfg.scaleOutQueueAgeSeconds} />

      <div className="row2" style={{ marginBottom: 14 }}>
        <LatencyCard series={latency} timeZone={tz} />
        <UsageCard usage={usage} />
      </div>

      <div className="row2" style={{ marginBottom: 14 }} id="workers">
        <div>
          <SecHead
            title="Worker instances"
            count={`${workers.healthy} healthy${starting ? ` · ${starting} starting` : ''} · max ${cfg.maxWorkers}`}
            actions={
              <Link className="btn tiny ghost" href="/system/workers">
                Workers
              </Link>
            }
          />
          <WorkersTable data={workers} />
        </div>
        <WorkerConfig settings={cfg} lastChange={cfg.lastChange} timeZone={tz} scaling={settings?.scaling} canEdit={canConfigure} />
      </div>

      <ProviderHealthGrid providers={providers} kinds={kinds} manageHref={canProviders ? '/connections?tab=providers' : null} />
      <McpHealthTable data={mcp} manageHref={hasPermission(session, Permission.MCP_READ) ? '/connections?tab=mcp' : null} />
      {auditStore !== undefined ? (
        <div style={{ marginBottom: 14 }} id="audit-store">
          <AuditStorePanel data={auditStore} timeZone={tz} canVerify={hasPermission(session, Permission.AUDIT_VERIFY)} />
        </div>
      ) : null}
      {storage !== undefined ? (
        <div style={{ marginBottom: 14 }} id="storage">
          <StoragePanel data={storage} timeZone={tz} />
        </div>
      ) : null}

      {plugins !== undefined ? (
        <div style={{ marginBottom: 14 }}>
          <PluginsPanel plugins={plugins} />
        </div>
      ) : null}

      <div className="row2 sys-bottom">
        <QueueCard queue={overview.queue} ageThreshold={cfg.scaleOutQueueAgeSeconds} depthThreshold={cfg.scaleOutQueueDepth} />
        <ChangesCard changes={changes} timeZone={tz} canAudit={hasPermission(session, Permission.AUDIT_READ)} />
      </div>
    </>
  );
}
