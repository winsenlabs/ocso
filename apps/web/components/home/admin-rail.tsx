import Link from 'next/link';
import { EmptyState } from '@/components/ui/empty-state';
import { KeyValue } from '@/components/ui/key-value';
import { DayList, RailCard } from '@/components/ui/rail-card';
import type { WorkerSettings } from '@/lib/api/settings';
import type { CapacityNow, ConnectionsSummary, PrivilegedChange } from '@/lib/api/system';
import { formatDuration, formatPercent, formatTime } from '@/lib/format';

const NO_DATA = <span className="mono-sm">no data yet</span>;

/** Live capacity (not reported yet) next to the configured worker limits (real, GET /v1/settings/workers). */
export function CapacityCard({ workers, capacity }: { workers: WorkerSettings | null; capacity: CapacityNow | null }) {
  const used = capacity && capacity.slotsTotal > 0 ? capacity.slotsUsed / capacity.slotsTotal : null;
  return (
    <RailCard title="Capacity" count="now">
      <KeyValue
        template="minmax(86px,100px) minmax(0,1fr)"
        items={[
          {
            k: 'slots used',
            v: capacity ? `${capacity.slotsUsed} of ${capacity.slotsTotal} · ${formatPercent(used, 0)}` : NO_DATA,
          },
          {
            k: 'queue depth',
            v: capacity ? `${capacity.queueDepth} · oldest ${formatDuration(capacity.oldestQueueAgeSeconds)}` : NO_DATA,
          },
          { k: 'warm floor', v: workers ? `${workers.minWarmWorkers} workers` : NO_DATA },
          { k: 'ceiling', v: workers ? `${workers.maxWorkers} workers` : NO_DATA },
          { k: 'autoscaling', v: workers ? (workers.autoscalingEnabled ? 'on' : 'off') : NO_DATA },
        ]}
      />
      {used !== null ? (
        <div className="pbar" style={{ marginTop: 10 }} role="img" aria-label={`${formatPercent(used, 0)} of slots used`}>
          <div style={{ width: `${Math.round(used * 100)}%` }} />
        </div>
      ) : null}
      <div className="rowsplit" style={{ marginTop: 10 }}>
        <Link className="btn tiny" href="/system/workers">
          Worker config
        </Link>
      </div>
    </RailCard>
  );
}

export function ConnectionsCard({ summary }: { summary: ConnectionsSummary | null }) {
  return (
    <RailCard title="Connections">
      {summary ? (
        <DayList
          rows={[
            {
              key: 'mcp',
              time: 'MCP',
              label: `${summary.mcp.servers} servers`,
              who: `${summary.mcp.tools} tools · ${summary.mcp.degraded} degraded`,
              flag: summary.mcp.degraded ? '!' : 'ok',
            },
            {
              key: 'llm',
              time: 'LLM',
              label: `${summary.llm.providers} providers`,
              who: `${summary.llm.profiles} profiles · ${summary.llm.elevated} elevated`,
              flag: summary.llm.elevated ? '!' : 'ok',
            },
            {
              key: 'chan',
              time: 'CHAN',
              label: `${summary.channels.count} channels`,
              who: summary.channels.unverified ? `${summary.channels.unverified} unverified` : 'all verified',
              flag: summary.channels.unverified ? '!' : 'ok',
            },
          ]}
        />
      ) : (
        <EmptyState size="sm" title="No connection health yet">
          MCP servers, model providers and channels with their health.
        </EmptyState>
      )}
      <div className="rowsplit" style={{ marginTop: 10 }}>
        <Link className="btn tiny ghost" href="/connections">
          Manage
        </Link>
      </div>
    </RailCard>
  );
}

export function PrivilegedChangesCard({ changes, timeZone }: { changes: PrivilegedChange[] | null; timeZone: string }) {
  return (
    <RailCard title="Recent privileged changes">
      {changes ? (
        <DayList
          rows={changes.map((c) => ({
            key: c.id,
            time: formatTime(c.at, timeZone),
            label: c.summary,
            who: `${c.actorName} · ${c.auditRef}`,
          }))}
        />
      ) : (
        <EmptyState size="sm" title="No audit feed yet">
          Configuration and role changes, attributed to the person who made them.
        </EmptyState>
      )}
      <div className="rowsplit" style={{ marginTop: 10 }}>
        <Link className="btn tiny ghost" href="/audit">
          Audit log
        </Link>
      </div>
    </RailCard>
  );
}
