import { Permission } from '@ocso/auth';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { SecHead } from '@/components/ui/sec-head';
import { ApiError } from '@/lib/api/errors';
import { loadWorkerDeployment, loadWorkerSettings } from '@/lib/api/system';
import { loadWorkersTelemetry } from '@/lib/api/telemetry';
import { hasPermission, requireSession } from '@/lib/session';
import { DeploymentPanel } from './deployment-panel';
import { LiveRefresh } from './live-refresh';
import { ScalingPanel } from './scaling-status';
import { WorkerConfig } from './worker-config';
import { WorkerConfigForm } from './worker-config-form';
import { toPercent } from './worker-form';
import { WorkersTable } from './workers-table';

/** Older API builds lack the deployment snapshot endpoint: show a labelled slot instead of failing the page. */
async function deploymentOrNull() {
  try {
    return await loadWorkerDeployment();
  } catch (err) {
    if (err instanceof ApiError && err.isMissingEndpoint) return null;
    throw err;
  }
}

/** /system/workers: fleet, scaling apply status, platform snapshot and the scaling settings (docs/10 §5–6). */
export async function WorkersBody() {
  const session = await requireSession();
  if (!hasPermission(session, Permission.SYSTEM_READ)) return <NotPermitted role={session.roleLabel} />;
  const tz = session.user.deployment.timezone;
  const [settings, deployment, fleet] = await Promise.all([
    loadWorkerSettings(),
    deploymentOrNull(),
    hasPermission(session, Permission.TELEMETRY_TECHNICAL_READ) ? loadWorkersTelemetry() : Promise.resolve(null),
  ]);
  const canConfigure = hasPermission(session, Permission.SYSTEM_CONFIGURE);

  return (
    <>
      <div className="rowsplit" style={{ marginBottom: 8 }}>
        <span className="mono-sm">
          scale out when the oldest waiting turn passes {settings.scaleOutQueueAgeSeconds}s or {settings.scaleOutQueueDepth} turns wait; hold{' '}
          {toPercent(settings.targetUtilization)}% of {settings.conversationsPerWorker} slots per worker; scale in after {settings.scaleInCooldownSeconds}s
        </span>
        <span className="sp" />
        <LiveRefresh events={['config.changed']} pollSeconds={15} />
      </div>

      <SecHead title="Worker fleet" count={fleet ? `${fleet.healthy} healthy · ${fleet.workers.length} reporting · max ${settings.maxWorkers}` : undefined} />
      {fleet ? <WorkersTable data={fleet} /> : null}
      {fleet ? (
        <p className="mono-sm" style={{ margin: '8px 0 0' }}>
          {fleet.definition}
        </p>
      ) : null}

      <div className="row2" style={{ margin: '14px 0' }}>
        <ScalingPanel scaling={settings.scaling} timeZone={tz} />
        <DeploymentPanel data={deployment} timeZone={tz} />
      </div>

      {canConfigure ? (
        <WorkerConfigForm initial={settings} />
      ) : (
        <WorkerConfig
          settings={settings}
          lastChange={fleet?.config.lastChange ?? null}
          timeZone={tz}
          scaling={settings.scaling}
          canEdit={false}
        />
      )}
    </>
  );
}
