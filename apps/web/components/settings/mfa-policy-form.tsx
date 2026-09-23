'use client';

import { useActionState } from 'react';
import { SettingsApprovalFields } from './approval-fields';
import { CheckboxGroup } from '@/components/forms/field';
import { AlertBanner } from '@/components/ui/alert-banner';
import { saveMfaPolicyAction } from '@/lib/actions/auth-settings';
import { IDLE } from '@/lib/actions/form-state';

/** Checkboxes for the roles that must use a second factor (TOTP, a passkey or SSO). */
export function MfaPolicyForm({ roles, selected }: { roles: Array<{ value: string; label: string }>; selected: string[] }) {
  const [state, action, pending] = useActionState(saveMfaPolicyAction, IDLE);
  return (
    <form action={action} className="ch" aria-label="Require MFA for roles" style={{ display: 'grid', gap: 12 }}>
      {state.message ? (
        <AlertBanner tone={state.status === 'error' ? 'error' : 'info'} style={{ margin: 0 }}>
          {state.message}
        </AlertBanner>
      ) : null}
      <CheckboxGroup idPrefix="mfa-policy" name="requireMfaRoles" label="Require MFA for roles" options={roles} defaultValues={selected} hint="users without an authenticator app must set one up at their next sign-in; passkeys and SSO count as MFA" />
      <span className="mono-sm">Break-glass: keep at least one Tech admin with a password and a saved set of backup codes. See the setup guide for account recovery.</span>
      <SettingsApprovalFields idPrefix="mfa" errors={state.fieldErrors} />
      <button type="submit" className="btn accent" disabled={pending} style={{ justifySelf: 'start' }}>
        {pending ? 'Submitting…' : 'Submit MFA policy for approval'}
      </button>
    </form>
  );
}
