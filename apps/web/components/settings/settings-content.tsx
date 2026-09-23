import { Permission } from '@ocso/auth';
import { KeyValue } from '@/components/ui/key-value';
import { SecHead } from '@/components/ui/sec-head';
import { getDeploymentSettings, type DeploymentSettings } from '@/lib/api/settings';
import { formatDateTime } from '@/lib/format';
import { hasPermission, requireSession } from '@/lib/session';
import { DeploymentForm } from './deployment-form';

/** Deployment settings (editable by the Tech Admin, read-only otherwise) and the user's account. */
export async function SettingsContent() {
  const [session, settings] = await Promise.all([requireSession(), getDeploymentSettings()]);
  const canEdit = hasPermission(session, Permission.DEPLOYMENT_SETTINGS_MANAGE);

  return (
    <div className="row2">
      <div>
        <SecHead title="Deployment" desc={canEdit ? 'Platform Tech Admin' : 'read only · managed by the Platform Tech Admin'} />
        {canEdit ? (
          <DeploymentForm
            timezones={Intl.supportedValuesOf('timeZone')}
            initial={{
              orgName: settings.orgName,
              deploymentLabel: settings.deploymentLabel,
              regionLabel: settings.regionLabel ?? '',
              timezone: settings.timezone,
              residencyZone: settings.residencyZone ?? '',
              execsCanViewAiActive: settings.execsCanViewAiActive,
              allowCrossProviderFallback: settings.allowCrossProviderFallback,
              allowCrossRegionFallback: settings.allowCrossRegionFallback,
            }}
          />
        ) : (
          <ReadOnlyDeployment settings={settings} />
        )}
      </div>
      <div>
        <SecHead title="Your account" />
        <section className="ch" aria-label="Your account">
          <KeyValue
            template="minmax(96px,120px) minmax(0,1fr)"
            items={[
              { k: 'name', v: session.user.name },
              { k: 'role', v: session.roleLabel },
              { k: 'permissions', v: `${session.permissions.size} granted by role` },
              { k: 'setup', v: formatDateTime(settings.setupCompletedAt ?? null, settings.timezone) },
            ]}
          />
          <span className="mono-sm">Theme: the moon button in the sidebar footer. It is remembered on this device.</span>
          <a className="btn tiny" href="/account/security" style={{ justifySelf: 'start', marginTop: 8 }}>
            Account security: password, two-factor, passkeys, sessions
          </a>
        </section>
      </div>
    </div>
  );
}

function ReadOnlyDeployment({ settings }: { settings: DeploymentSettings }) {
  return (
    <section className="ch" aria-label="Deployment settings">
      <KeyValue
        items={[
          { k: 'organization', v: settings.orgName },
          { k: 'label', v: settings.deploymentLabel },
          { k: 'region', v: settings.regionLabel ?? 'not set' },
          { k: 'timezone', v: settings.timezone },
          { k: 'residency', v: settings.residencyZone ?? 'not set' },
          { k: 'execs see ai-active', v: settings.execsCanViewAiActive ? 'yes' : 'no' },
          { k: 'provider fallback', v: settings.allowCrossProviderFallback ? 'allowed' : 'not allowed' },
          { k: 'region fallback', v: settings.allowCrossRegionFallback ? 'allowed' : 'not allowed' },
        ]}
      />
    </section>
  );
}
