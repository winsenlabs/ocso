import { AlertBanner } from '@/components/ui/alert-banner';
import { getWorkerSettings } from '@/lib/api/settings';
import { requireSession } from '@/lib/session';
import { WorkerConfig } from './worker-config';

/** Loads GET /v1/settings/workers (system.read) and renders the config grid. */
export async function WorkerConfigSection() {
  const [session, settings] = await Promise.all([requireSession(), getWorkerSettings().catch(() => null)]);
  return (
    <div style={{ marginBottom: 14 }}>
      {settings ? (
        <WorkerConfig settings={settings} timeZone={session.user.deployment.timezone} />
      ) : (
        <AlertBanner tone="warn" title="Worker configuration could not be loaded." />
      )}
    </div>
  );
}
