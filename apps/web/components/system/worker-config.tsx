import type { WorkerSettings } from '@/lib/api/settings';
import { formatDateTime, formatPercent } from '@/lib/format';

/** Worker configuration grid (design/03 .cfg), read from GET /v1/settings/workers. */
export function WorkerConfig({ settings, timeZone }: { settings: WorkerSettings; timeZone: string }) {
  const fields: Array<{ label: string; value: string; hint: string }> = [
    { label: 'min warm workers', value: String(settings.minWarmWorkers), hint: 'floor in production' },
    { label: 'max workers', value: String(settings.maxWorkers), hint: 'hard ceiling' },
    { label: 'convs per worker', value: String(settings.conversationsPerWorker), hint: 'nominal, benchmarked' },
    { label: 'autoscale target', value: formatPercent(settings.targetUtilization, 0), hint: 'active slots used' },
    { label: 'scale-out at', value: `${settings.scaleOutQueueAgeSeconds}s`, hint: 'oldest queue item' },
    { label: 'scale-out depth', value: String(settings.scaleOutQueueDepth), hint: 'queued items' },
    { label: 'scale-in cooldown', value: `${settings.scaleInCooldownSeconds}s`, hint: 'after last scale-out' },
    { label: 'turn timeout', value: `${settings.turnTimeoutSeconds}s`, hint: 'per agent execution' },
    { label: 'lease / heartbeat', value: `${settings.leaseDurationSeconds} / ${settings.heartbeatIntervalSeconds}s`, hint: 'conversation ownership' },
    { label: 'autoscaling', value: settings.autoscalingEnabled ? 'on' : 'off', hint: 'deployment adapter' },
  ];
  return (
    <section className="ch" style={{ alignContent: 'start' }} aria-label="Worker configuration">
      <div className="t">
        <h3>Worker configuration</h3>
        <span className="mono-sm">applies on next scale event</span>
      </div>
      <div className="cfg">
        {fields.map((f) => (
          <div className="f" key={f.label}>
            <div className="l">{f.label}</div>
            <div className="vv">{f.value}</div>
            <div className="h">{f.hint}</div>
          </div>
        ))}
      </div>
      <div className="rowsplit">
        <span className="sp" />
        <span className="mono-sm">last change {formatDateTime(settings.updatedAt ?? null, timeZone)}</span>
      </div>
    </section>
  );
}
