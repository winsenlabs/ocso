import Link from 'next/link';
import { KeyValue } from '@/components/ui/key-value';
import { RailCard } from '@/components/ui/rail-card';
import type { QueueDepth } from '@/lib/api/telemetry';
import { formatDuration, formatNumber } from '@/lib/format';

/** Queue depth and age (docs/10 §6): the conversation-turn topic drives scale-out; other topics listed when busy. */
export function QueueCard({ queue, ageThreshold, depthThreshold }: { queue: QueueDepth; ageThreshold: number | null; depthThreshold: number | null }) {
  const busy = queue.topics.filter((t) => t.topic !== queue.turn.topic && (t.depth > 0 || t.inFlight > 0 || t.dead > 0));
  return (
    <RailCard title="Queues" count={queue.source === 'adapter' ? 'queue adapter' : 'jobs table'}>
      <KeyValue
        template="minmax(96px,120px) minmax(0,1fr)"
        items={[
          {
            k: 'turn queue',
            v: `${formatNumber(queue.turn.depth)} waiting · oldest ${formatDuration(queue.turn.oldestAgeSeconds ?? 0)}${
              ageThreshold !== null ? ` (scale out > ${ageThreshold}s${depthThreshold !== null ? ` or > ${depthThreshold}` : ''})` : ''
            }`,
          },
          { k: 'all topics', v: `${formatNumber(queue.depth)} waiting · ${formatNumber(queue.inFlight)} in flight` },
          { k: 'dead letters', v: queue.dead ? <span style={{ color: 'var(--danger)', fontWeight: 600 }}>{formatNumber(queue.dead)}</span> : 'none' },
          ...busy.slice(0, 4).map((t) => ({ k: t.topic, v: `${t.depth} waiting · ${t.inFlight} running${t.dead ? ` · ${t.dead} dead` : ''}` })),
        ]}
      />
      <div className="rowsplit" style={{ marginTop: 10 }}>
        <Link className="btn tiny ghost" href="/system/queues">
          Queues &amp; leases
        </Link>
      </div>
    </RailCard>
  );
}
