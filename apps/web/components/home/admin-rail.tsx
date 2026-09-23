import Link from 'next/link';
import { KeyValue } from '@/components/ui/key-value';
import { DayList, RailCard } from '@/components/ui/rail-card';
import type { AdminHomeData } from '@/lib/api/home';
import { formatDuration, formatPercent } from '@/lib/format';

/** Live capacity (design/06 admin): healthy-worker slots, queue, and the configured floor/ceiling. */
export function CapacityCard({ capacity }: { capacity: AdminHomeData['capacity'] }) {
  const used = capacity.utilization;
  return (
    <RailCard title="Capacity" count="now">
      <KeyValue
        template="minmax(86px,100px) minmax(0,1fr)"
        items={[
          { k: 'slots used', v: capacity.slotsTotal ? `${capacity.slotsUsed} of ${capacity.slotsTotal} · ${formatPercent(used, 0)}` : 'no healthy worker' },
          { k: 'queue depth', v: `${capacity.queueDepth} · oldest ${formatDuration(capacity.oldestAgeSeconds ?? 0)}` },
          { k: 'warm floor', v: `${capacity.warmFloor} workers` },
          { k: 'ceiling', v: `${capacity.ceiling} workers` },
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

/** Connection health counts (design/06 admin "Connections"). */
export function ConnectionsCard({ connections }: { connections: AdminHomeData['connections'] }) {
  const { mcp, providers, channels } = connections;
  const inactive = channels.channels - channels.active;
  return (
    <RailCard title="Connections">
      <DayList
        rows={[
          {
            key: 'mcp',
            time: 'MCP',
            label: `${mcp.servers} server${mcp.servers === 1 ? '' : 's'}`,
            who: `${mcp.tools} tools · ${mcp.degraded} degraded`,
            flag: mcp.degraded ? '!' : mcp.servers ? 'ok' : '—',
          },
          {
            key: 'llm',
            time: 'LLM',
            label: `${providers.providers} provider${providers.providers === 1 ? '' : 's'}`,
            who: `${providers.profiles} profiles · ${providers.degraded} degraded`,
            flag: providers.degraded ? '!' : providers.providers ? 'ok' : '—',
          },
          {
            key: 'chan',
            time: 'CHAN',
            label: `${channels.channels} channel${channels.channels === 1 ? '' : 's'}`,
            who: [inactive ? `${inactive} inactive` : 'all active', channels.failedDeliveries1h ? `${channels.failedDeliveries1h} failed deliveries 1h` : null]
              .filter(Boolean)
              .join(' · '),
            flag: inactive || channels.failedDeliveries1h ? '!' : channels.channels ? 'ok' : '—',
          },
        ]}
      />
      <div className="rowsplit" style={{ marginTop: 10 }}>
        <Link className="btn tiny ghost" href="/connections">
          Manage
        </Link>
      </div>
    </RailCard>
  );
}
