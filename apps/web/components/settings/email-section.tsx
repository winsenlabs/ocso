import { Permission } from '@ocso/auth';
import { AlertBanner } from '@/components/ui/alert-banner';
import { KeyValue } from '@/components/ui/key-value';
import { SecHead } from '@/components/ui/sec-head';
import { StatusChip } from '@/components/ui/status-chip';
import { getEmailSettings } from '@/lib/api/email-settings';
import { describeApiError } from '@/lib/api/errors';
import { deliveryStatus, driverLabel, statusNotes, type EmailSettings } from '@/lib/email-settings-form';
import { hasPermission, requireSession } from '@/lib/session';
import { EmailTestForm } from './email-test-form';

/**
 * Transactional email status for the Tech admin (read only: the
 * deployment configures it) plus a test send. A failing API call degrades to a
 * banner instead of breaking the Settings page.
 */
export async function EmailSection() {
  const session = await requireSession();
  if (!hasPermission(session, Permission.DEPLOYMENT_SETTINGS_MANAGE)) return null;
  let settings: EmailSettings | null = null;
  let error: string | null = null;
  try {
    settings = await getEmailSettings();
  } catch (err) {
    error = describeApiError(err);
  }
  return (
    <div className="row2" style={{ marginTop: 24 }}>
      <div>
        <SecHead title="Email" desc="invites, password resets, sign-in codes, alert emails · Tech admin" />
        <div style={{ display: 'grid', gap: 12 }}>
          <section className="ch" aria-label="Email configuration">
            {settings ? <EmailStatus settings={settings} /> : <AlertBanner tone="error" style={{ margin: 0 }}>{`Email status unavailable: ${error ?? 'unknown error'}`}</AlertBanner>}
            <span className="mono-sm">Configured by the deployment (see docs/operations/compose.md).</span>
          </section>
          <EmailTestForm />
        </div>
      </div>
    </div>
  );
}

function EmailStatus({ settings }: { settings: EmailSettings }) {
  const status = deliveryStatus(settings);
  return (
    <>
      <KeyValue
        template="minmax(96px,120px) minmax(0,1fr)"
        items={[
          { k: 'driver', v: driverLabel(settings) },
          { k: 'from', v: settings.from ?? 'not set' },
          { k: 'reply-to', v: settings.replyTo ?? 'not set' },
          { k: 'status', v: <StatusChip tone={status.tone}>{status.label}</StatusChip> },
        ]}
      />
      {statusNotes(settings).map((note) => (
        <AlertBanner key={note} tone="warn" style={{ margin: 0 }}>
          {note}
        </AlertBanner>
      ))}
    </>
  );
}
