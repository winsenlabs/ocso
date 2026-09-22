import { AlertBanner } from '@/components/ui/alert-banner';
import { KeyValue, type KeyValueItem } from '@/components/ui/key-value';
import { StatusChip } from '@/components/ui/status-chip';
import type { EcsDeploymentStatus, WorkerDeployment } from '@/lib/api/system';
import { formatDateTime } from '@/lib/format';

function ecsItems(d: EcsDeploymentStatus): KeyValueItem[] {
  const count = (v: number | null) => (v === null ? '—' : String(v));
  return [
    { k: 'service', v: `${d.cluster} / ${d.service} · ${d.serviceStatus.toLowerCase()}` },
    { k: 'tasks', v: `desired ${count(d.desiredCount)} · running ${count(d.runningCount)} · pending ${count(d.pendingCount)}` },
    { k: 'rollout', v: d.rolloutState?.toLowerCase() ?? '—' },
    {
      k: 'scalable target',
      v: d.scalableTarget
        ? `${d.scalableTarget.minCapacity} – ${d.scalableTarget.maxCapacity}${d.scalableTarget.dynamicScalingSuspended ? ' · dynamic scaling suspended' : ''}`
        : 'not registered',
    },
    {
      k: 'policies',
      v: d.policies.length ? (
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {d.policies.map((p) => (
            <StatusChip key={p.name} tone={p.present ? 'good' : 'danger'} title={p.type}>
              {p.name}
              {p.present ? '' : ' · missing'}
            </StatusChip>
          ))}
        </span>
      ) : (
        'none'
      ),
    },
    {
      k: 'alarms',
      v: d.alarms.length ? (
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {d.alarms.map((a) => (
            <StatusChip key={a.name} tone={a.state === 'OK' ? 'good' : a.state === 'ALARM' ? 'danger' : 'muted'}>
              {a.name} · {a.state.toLowerCase().replace(/_/g, ' ')}
            </StatusChip>
          ))}
        </span>
      ) : (
        'none'
      ),
    },
  ];
}

/**
 * The worker service as the platform reports it (GET /v1/settings/workers/deployment):
 * the worker leader's last describe() — ECS desired/running/pending, scalable
 * target, policies, alarms; Compose reports that replicas are operator-managed.
 */
export function DeploymentPanel({ data, timeZone }: { data: WorkerDeployment | null; timeZone: string }) {
  const d = data?.deployment ?? null;
  return (
    <section className="ch" aria-label="Worker deployment">
      <div className="t">
        <h3>Worker deployment</h3>
        <span className="mono-sm">{data?.driver ? `${data.driver} · described ${formatDateTime(data.describedAt, timeZone)}` : 'not described yet'}</span>
      </div>
      {data === null ? (
        <p className="mono-sm" style={{ margin: 0 }}>
          This API build does not serve the deployment snapshot (GET /v1/settings/workers/deployment).
        </p>
      ) : null}
      {data?.describeError ? (
        <AlertBanner tone="warn" title="The latest describe failed" style={{ margin: 0 }}>
          {data.describeError} — the snapshot below is older.
        </AlertBanner>
      ) : null}
      {d === null && data !== null ? (
        <p className="mono-sm" style={{ margin: 0 }}>
          The worker leader records the platform&apos;s view of the worker service after it starts; nothing has been recorded yet.
        </p>
      ) : null}
      {d && d.driver === 'ecs' && 'cluster' in d ? <KeyValue template="minmax(110px,130px) minmax(0,1fr)" items={ecsItems(d as EcsDeploymentStatus)} /> : null}
      {d && d.driver === 'compose' && 'note' in d ? (
        <KeyValue
          template="minmax(110px,130px) minmax(0,1fr)"
          items={[
            { k: 'replicas', v: 'managed by the operator (docker compose)' },
            { k: 'note', v: String(d.note) },
            { k: 'checked', v: formatDateTime(d.checkedAt ?? null, timeZone) },
          ]}
        />
      ) : null}
      {d && d.driver !== 'ecs' && d.driver !== 'compose' ? <p className="mono-sm">driver {d.driver} reported; no detailed view for it yet.</p> : null}
    </section>
  );
}
