import { AlertBanner } from '@/components/ui/alert-banner';
import { KeyValue, type KeyValueItem } from '@/components/ui/key-value';
import { StatusChip } from '@/components/ui/status-chip';
import type { DeploymentFactView, WorkerDeployment } from '@/lib/api/system';
import { formatDateTime } from '@/lib/format';

const CHIP_TONES = new Set(['good', 'danger', 'muted']);

/** A driver's panel rows: plain values, or named states as chips (policies, alarms). */
function factItems(facts: readonly DeploymentFactView[]): KeyValueItem[] {
  return facts.map((f) => ({
    k: f.label,
    v: f.states?.length ? (
      <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {f.states.map((st) => (
          <StatusChip key={st.name} tone={CHIP_TONES.has(st.tone) ? (st.tone as 'good' | 'danger' | 'muted') : 'muted'} {...(st.title ? { title: st.title } : {})}>
            {st.name}
          </StatusChip>
        ))}
      </span>
    ) : (
      f.value
    ),
  }));
}

/**
 * The worker service as the platform reports it (GET /v1/settings/workers/deployment):
 * the worker leader's last describe(), rendered from the rows the deployment
 * driver writes itself (`facts`), so any driver shows without UI changes.
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
      {d?.facts?.length ? <KeyValue template="minmax(110px,130px) minmax(0,1fr)" items={factItems(d.facts)} /> : null}
      {d && !d.facts?.length ? <p className="mono-sm">{d.note ?? `driver ${d.driver} reported; its details appear after the next describe.`}</p> : null}
    </section>
  );
}
