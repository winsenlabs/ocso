import { EmptyState } from '@/components/ui/empty-state';
import { StatusChip } from '@/components/ui/status-chip';
import type { WorkersTelemetry } from '@/lib/api/telemetry';
import { formatDuration, formatPercent } from '@/lib/format';
import { formatMemory, utilClass, workerChip, workerLabel } from './system-meta';

const TEMPLATE = 'minmax(88px,1fr) 96px 58px minmax(56px,0.8fr) 96px 62px 70px';

/**
 * Worker instances (design/03 .dt-wk) and the lease accounting row. The design's
 * Drain / Restart pool controls are omitted: the API exposes no such commands
 * (scaling is applied by the deployment adapter).
 */
export function WorkersTable({ data }: { data: WorkersTelemetry }) {
  const { workers, leases } = data;
  if (workers.length === 0) {
    return (
      <EmptyState title="No worker has reported yet">
        Workers register and heartbeat every {leases.heartbeatIntervalSeconds}s once they start. Start the worker service (apps/worker) against this
        database; until then no conversation can be answered by an agent.
      </EmptyState>
    );
  }
  const slotShare = leases.slotsTotal > 0 ? leases.active / leases.slotsTotal : null;
  return (
    <div className="dtable dt-wk" role="table" aria-label="Worker instances">
      <div className="dt-head" role="row" style={{ gridTemplateColumns: TEMPLATE }}>
        {['Worker', 'Status', 'Convs', 'Utilisation', 'Memory / CPU', 'Started', 'Heartbeat'].map((h) => (
          <span key={h} role="columnheader">
            {h}
          </span>
        ))}
      </div>
      {workers.map((w) => {
        const chip = workerChip(w.effectiveStatus);
        const util = w.utilization;
        return (
          <div key={w.id} className="dt-row" role="row" style={{ gridTemplateColumns: TEMPLATE }}>
            <span role="cell" className="mono" style={{ fontSize: 11.5 }} title={`${w.id} · ${w.version}${w.platformRef ? ` · ${w.platformRef}` : ''}`}>
              {workerLabel(w)}
            </span>
            <span role="cell">
              <StatusChip tone={chip.tone}>{chip.label}</StatusChip>
            </span>
            <span role="cell" className="mono">
              {w.activeLeases} / {w.capacity}
            </span>
            <span role="cell" title={util === null ? 'no capacity' : `${formatPercent(util, 0)} of slots leased · ${w.busyTurns} turns running`}>
              <span className="util" role="img" aria-label={util === null ? 'utilisation unknown' : `${formatPercent(util, 0)} utilised`}>
                <i className={utilClass(util)} style={{ width: `${Math.max(2, Math.round((util ?? 0) * 100))}%` }} />
              </span>
            </span>
            <span role="cell" className="mono-sm">
              {formatMemory(w.memoryMb)} · {w.cpuPercent === null ? '—' : `${Math.round(w.cpuPercent)}%`}
            </span>
            <span role="cell" className="mono-sm">
              {formatDuration(w.uptimeSeconds)}
            </span>
            <span role="cell" className="mono-sm">
              {formatDuration(w.heartbeatAgeSeconds)} ago
            </span>
          </div>
        );
      })}
      <div className="dt-row" role="row" style={{ gridTemplateColumns: TEMPLATE, background: 'var(--bg-2)' }} title={leases.definitions['recoveredToday']}>
        <span role="cell" className="mono-sm">
          leases
        </span>
        <span role="cell" className="mono-sm">
          {leases.active} active · {leases.busy} busy
        </span>
        <span role="cell" className="mono">
          {leases.active} / {leases.slotsTotal}
        </span>
        <span role="cell">
          <span className="util" role="img" aria-label={`${formatPercent(slotShare, 0)} of slots leased`}>
            <i className={utilClass(slotShare)} style={{ width: `${Math.max(2, Math.round((slotShare ?? 0) * 100))}%` }} />
          </span>
        </span>
        <span role="cell" className="mono-sm">
          recovered {leases.recoveredToday} today
        </span>
        <span role="cell" className="mono-sm">
          lease {leases.leaseDurationSeconds}s
        </span>
        <span role="cell" className="mono-sm">
          hb {leases.heartbeatIntervalSeconds}s
        </span>
      </div>
    </div>
  );
}
