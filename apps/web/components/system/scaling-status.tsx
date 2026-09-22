import { AlertBanner } from '@/components/ui/alert-banner';
import { KeyValue } from '@/components/ui/key-value';
import { StatusChip, type StatusTone } from '@/components/ui/status-chip';
import type { ScalingStatus } from '@/lib/api/system';
import { formatDateTime } from '@/lib/format';

const CHIP: Record<ScalingStatus['status'], { tone: StatusTone; label: string }> = {
  APPLIED: { tone: 'good', label: 'applied' },
  ADVISORY: { tone: 'warn', label: 'advisory · operator action' },
  FAILED: { tone: 'danger', label: 'apply failed' },
  PENDING: { tone: 'muted', label: 'pending apply' },
};

export function ScalingChip({ scaling }: { scaling: ScalingStatus }) {
  const chip = CHIP[scaling.status];
  return (
    <StatusChip tone={chip.tone} title={scaling.message}>
      {chip.label}
    </StatusChip>
  );
}

const bound = (v: number | null, unit = '') => (v === null ? 'n/a' : `${v}${unit}`);

/**
 * How far the deployment platform has applied the worker settings (ADR-023):
 * applied, advisory with the exact operator commands (Compose), failed with
 * the reason, or pending while the worker leader has not picked the change up.
 */
export function ScalingPanel({ scaling, timeZone }: { scaling: ScalingStatus | undefined; timeZone: string }) {
  if (!scaling) {
    return (
      <section className="ch" aria-label="Scaling apply status">
        <div className="t">
          <h3>Scaling apply status</h3>
        </div>
        <p className="mono-sm" style={{ margin: 0 }}>
          This API build does not report whether the deployment applied the worker settings (GET /v1/settings/workers has no scaling field).
        </p>
      </section>
    );
  }
  const e = scaling.effective;
  const tone = scaling.status === 'FAILED' ? 'error' : scaling.status === 'ADVISORY' ? 'warn' : 'info';
  return (
    <section className="ch" aria-label="Scaling apply status">
      <div className="t">
        <h3>Scaling apply status</h3>
        <span className="mono-sm">{scaling.driver ? `driver ${scaling.driver}` : 'no driver reported yet'}</span>
        <span style={{ marginLeft: 'auto' }}>
          <ScalingChip scaling={scaling} />
        </span>
      </div>
      <AlertBanner tone={tone} style={{ margin: 0 }}>
        {scaling.message}
      </AlertBanner>
      {scaling.commands.length ? (
        <div>
          <div className="mono-sm" style={{ marginBottom: 4 }}>
            run on the host
          </div>
          <pre className="cmd-block" aria-label="Operator commands">
            {scaling.commands.join('\n')}
          </pre>
        </div>
      ) : null}
      {scaling.warnings.length ? (
        <ul className="plain-list warn-list" aria-label="Warnings">
          {scaling.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      {scaling.changes.length ? (
        <ul className="plain-list" aria-label="Changes made on the platform">
          {scaling.changes.map((c) => (
            <li key={c} className="mono-sm">
              {c}
            </li>
          ))}
        </ul>
      ) : null}
      <KeyValue
        template="minmax(120px,150px) minmax(0,1fr)"
        items={[
          { k: 'effective capacity', v: e ? `${e.minCapacity} – ${e.maxCapacity} workers · autoscaling ${e.autoscaling ? 'on' : 'pinned'}` : 'not applied yet' },
          { k: 'target', v: e ? `${bound(e.targetSlotDemandPerWorker)} slot demand per worker · queue age ${bound(e.queueAgeThresholdSeconds, 's')}` : '—' },
          { k: 'cooldowns', v: e ? `in ${bound(e.scaleInCooldownSeconds, 's')} · out ${bound(e.scaleOutCooldownSeconds, 's')}` : '—' },
          { k: 'last attempt', v: `${formatDateTime(scaling.attemptedAt, timeZone)}${scaling.lastOutcome ? ` · ${scaling.lastOutcome.toLowerCase()}` : ''}` },
          { k: 'last success', v: formatDateTime(scaling.lastSucceededAt, timeZone) },
          { k: 'in sync', v: scaling.inSync ? 'yes — the platform has the latest settings' : 'no — the newest change is not applied yet' },
        ]}
      />
    </section>
  );
}
