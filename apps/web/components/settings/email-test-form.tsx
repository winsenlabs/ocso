'use client';

import { useActionState } from 'react';
import { TextField } from '@/components/forms/field';
import { AlertBanner } from '@/components/ui/alert-banner';
import { sendTestEmailAction } from '@/lib/actions/email-settings';
import { IDLE } from '@/lib/actions/form-state';
import type { EmailTestState } from '@/lib/email-settings-form';

/** Sends one test email with the deployment's current configuration → POST /v1/settings/email/test. */
export function EmailTestForm() {
  const [state, action, pending] = useActionState<EmailTestState, FormData>(sendTestEmailAction, IDLE);
  return (
    <form action={action} noValidate className="ch" style={{ gap: 12 }} aria-label="Send a test email">
      {state.message ? (
        <AlertBanner tone={state.tone ?? (state.status === 'error' ? 'error' : 'info')} style={{ margin: 0 }}>
          {state.message}
        </AlertBanner>
      ) : null}
      <TextField
        idPrefix="email-test"
        name="to"
        type="email"
        label="Send a test email to"
        autoComplete="email"
        defaultValue={state.values?.['to'] ?? ''}
        error={state.fieldErrors?.['to']}
        hint="uses the deployment's current email configuration"
      />
      <div className="rowsplit">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? 'Sending…' : 'Send test email'}
        </button>
      </div>
    </form>
  );
}
