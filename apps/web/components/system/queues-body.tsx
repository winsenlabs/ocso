import { Permission } from '@ocso/auth';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { DataTable } from '@/components/ui/data-table';
import { KeyValue } from '@/components/ui/key-value';
import { RailCard } from '@/components/ui/rail-card';
import { SecHead } from '@/components/ui/sec-head';
import { StatusChip } from '@/components/ui/status-chip';
import { Tile, Tiles } from '@/components/ui/tile';
import { loadTelemetryOverview, loadWorkersTelemetry, type TopicDepth } from '@/lib/api/telemetry';
import { formatDuration, formatNumber, formatPercent } from '@/lib/format';
import { hasPermission, requireSession } from '@/lib/session';
import { LiveRefresh } from './live-refresh';

/** What each queue topic carries (packages/queue TOPICS). */
const PURPOSE: Record<string, string> = {
  'conversation.turn': 'agent turns — drives scale-out',
  'channel.deliver': 'outbound channel messages',
  'media.fetch': 'inbound media downloads',
  'conversation.summarize': 'conversation summaries',
  'conversation.insights': 'post-conversation insights',
  'copilot.suggest': 'copilot drafts for humans',
  'tool.execute_confirmed': 'confirmed sensitive tool calls',
  'alert.deliver': 'alert notifications',
  'webhook.deliver': 'outbound webhooks',
  'evaluation.run': 'prompt evaluations',
};

/** /system/queues: per-topic depth, age and dead letters, plus conversation lease accounting (docs/10 §2, §6). */
export async function QueuesBody() {
  const session = await requireSession();
  if (!hasPermission(session, Permission.TELEMETRY_TECHNICAL_READ)) return <NotPermitted role={session.roleLabel} />;
  const [overview, workers] = await Promise.all([loadTelemetryOverview(), loadWorkersTelemetry()]);
  const q = overview.queue;
  const cfg = workers.config;
  const leases = workers.leases;
  const turnAge = q.turn.oldestAgeSeconds;
  const over = (t: TopicDepth) => t.topic === q.turn.topic && ((t.oldestAgeSeconds ?? 0) > cfg.scaleOutQueueAgeSeconds || t.depth > cfg.scaleOutQueueDepth);

  return (
    <>
      <div className="rowsplit" style={{ marginBottom: 8 }}>
        <span className="mono-sm">
          source: {q.source === 'adapter' ? 'the configured queue adapter' : 'the PostgreSQL jobs table'} · depth counts messages ready now
        </span>
        <span className="sp" />
        <LiveRefresh pollSeconds={10} />
      </div>
      <Tiles min={140}>
        <Tile label="turns waiting" value={formatNumber(q.turn.depth)} {...(q.turn.depth > cfg.scaleOutQueueDepth ? { tone: 'warn' as const } : {})} />
        <Tile
          label="oldest turn"
          value={turnAge === null ? 'none waiting' : formatDuration(turnAge)}
          {...(turnAge !== null && turnAge > cfg.scaleOutQueueAgeSeconds ? { tone: 'warn' as const } : {})}
        />
        <Tile label="all topics waiting" value={formatNumber(q.depth)} />
        <Tile label="in flight" value={formatNumber(q.inFlight)} />
        <Tile label="dead letters" value={formatNumber(q.dead)} {...(q.dead > 0 ? { tone: 'warn' as const } : {})} />
        <Tile label="leases active" value={`${leases.active} of ${leases.slotsTotal}`} />
      </Tiles>

      <div className="row2">
        <div>
          <SecHead title="Queue topics" count={q.topics.length} desc={`scale out above ${cfg.scaleOutQueueAgeSeconds}s or ${cfg.scaleOutQueueDepth} waiting turns`} />
          <DataTable
            label="Queue topics"
            template="minmax(0,1.4fr) 76px 76px 76px 96px 110px"
            rows={q.topics}
            rowKey={(t) => t.topic}
            columns={[
              {
                key: 'topic',
                header: 'Topic',
                cell: (t) => (
                  <>
                    <b className="mono" style={{ fontSize: 12 }}>
                      {t.topic}
                    </b>
                    <span className="mono-sm" style={{ display: 'block' }}>
                      {PURPOSE[t.topic] ?? 'queue topic'}
                    </span>
                  </>
                ),
              },
              { key: 'depth', header: 'Waiting', cell: (t) => <span className="mono">{formatNumber(t.depth)}</span> },
              { key: 'flight', header: 'In flight', cell: (t) => <span className="mono">{formatNumber(t.inFlight)}</span> },
              {
                key: 'dead',
                header: 'Dead',
                cell: (t) => (
                  <span className="mono" style={t.dead ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>
                    {formatNumber(t.dead)}
                  </span>
                ),
              },
              { key: 'age', header: 'Oldest', cell: (t) => <span className="mono">{t.oldestAgeSeconds === null ? '—' : formatDuration(t.oldestAgeSeconds)}</span> },
              {
                key: 'state',
                header: 'State',
                cell: (t) =>
                  over(t) ? (
                    <StatusChip tone="warn">scaling signal</StatusChip>
                  ) : t.dead ? (
                    <StatusChip tone="danger">dead letters</StatusChip>
                  ) : t.depth ? (
                    <StatusChip tone="accent">draining</StatusChip>
                  ) : (
                    <StatusChip tone="good">idle</StatusChip>
                  ),
              },
            ]}
          />
        </div>
        <div className="rail">
          <RailCard title="Conversation leases" count={`${formatPercent(leases.slotsTotal ? leases.active / leases.slotsTotal : null, 0)} of slots`}>
            <KeyValue
              template="minmax(96px,120px) minmax(0,1fr)"
              items={[
                { k: 'active', v: `${leases.active} leases · ${leases.busy} running a turn` },
                { k: 'slots', v: `${leases.slotsTotal} on healthy workers` },
                { k: 'recovered', v: `${leases.recoveredToday} today` },
                { k: 'lease', v: `${leases.leaseDurationSeconds}s · heartbeat ${leases.heartbeatIntervalSeconds}s` },
              ]}
            />
            <p className="mono-sm" style={{ margin: '10px 0 0' }}>
              {leases.definitions['recoveredToday'] ?? ''}
            </p>
          </RailCard>
        </div>
      </div>
    </>
  );
}
