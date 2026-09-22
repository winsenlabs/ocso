import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatDateTime } from '@/lib/format';
import type { ScalingStatus } from '@/lib/api/system';
import { ScalingChip } from './scaling-status';
import { toPercent } from './worker-form';

export interface WorkerConfigValues {
  minWarmWorkers: number;
  maxWorkers: number;
  conversationsPerWorker: number;
  targetUtilization: number;
  scaleOutQueueAgeSeconds: number;
  scaleOutQueueDepth: number;
  scaleInCooldownSeconds: number;
  turnTimeoutSeconds: number;
  leaseDurationSeconds: number;
  heartbeatIntervalSeconds: number;
  autoscalingEnabled: boolean;
}

/** Worker configuration grid (design/03 .cfg), read-only; editing lives on /system/workers. */
export function WorkerConfig({
  settings,
  lastChange,
  timeZone,
  scaling,
  canEdit,
  footer,
}: {
  settings: WorkerConfigValues;
  lastChange: { at: string; actorName: string | null } | null;
  timeZone: string;
  scaling?: ScalingStatus | undefined;
  canEdit: boolean;
  footer?: ReactNode;
}) {
  const fields: Array<{ label: string; value: string; hint: string }> = [
    { label: 'min warm workers', value: String(settings.minWarmWorkers), hint: 'floor kept running' },
    { label: 'max workers', value: String(settings.maxWorkers), hint: 'hard ceiling' },
    { label: 'convs per worker', value: String(settings.conversationsPerWorker), hint: 'nominal, benchmarked' },
    { label: 'autoscale target', value: `${toPercent(settings.targetUtilization)}%`, hint: 'active slots used' },
    { label: 'scale-out at', value: `${settings.scaleOutQueueAgeSeconds}s · ${settings.scaleOutQueueDepth}`, hint: 'oldest queue item · depth' },
    { label: 'scale-in cooldown', value: `${settings.scaleInCooldownSeconds}s`, hint: 'after last scale-out' },
    { label: 'turn timeout', value: `${settings.turnTimeoutSeconds}s`, hint: 'per agent execution' },
    { label: 'lease / heartbeat', value: `${settings.leaseDurationSeconds} / ${settings.heartbeatIntervalSeconds}s`, hint: 'conversation ownership' },
  ];
  return (
    <section className="ch" style={{ alignContent: 'start' }} aria-label="Worker configuration">
      <div className="t">
        <h3>Worker configuration</h3>
        <span className="mono-sm">autoscaling {settings.autoscalingEnabled ? 'on' : 'off'} · scales on queue age and slot demand, not CPU</span>
        {scaling ? (
          <span style={{ marginLeft: 'auto' }}>
            <ScalingChip scaling={scaling} />
          </span>
        ) : null}
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
        {canEdit ? (
          <Link className="btn tiny accent" href="/system/workers#worker-config">
            Edit configuration
          </Link>
        ) : null}
        {footer}
        <span className="sp" />
        <span className="mono-sm">
          {lastChange ? `last change ${formatDateTime(lastChange.at, timeZone)}${lastChange.actorName ? ` · ${lastChange.actorName}` : ''}` : 'defaults · never changed'}
        </span>
      </div>
    </section>
  );
}
