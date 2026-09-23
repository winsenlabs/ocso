'use client';

import { useActionState, useEffect, useState } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { setupAction } from '@/lib/actions/auth';
import { IDLE } from '@/lib/actions/form-state';
import { AuthField } from './auth-field';

/**
 * First-run setup: setup token from the API log, organization, the first
 * Tech admin and the deployment timezone.
 */
export function SetupForm({ timezones }: { timezones: string[] }) {
  const [state, action, pending] = useActionState(setupAction, IDLE);
  const errors = state.fieldErrors ?? {};
  const values = state.values ?? {};
  const [timezone, setTimezone] = useState(values['timezone'] || 'UTC');
  const [touched, setTouched] = useState(false);

  // Default to the browser's zone once mounted (server render cannot know it).
  useEffect(() => {
    if (touched) return;
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (zone && timezones.includes(zone)) setTimezone(zone);
    } catch {
      // keep UTC
    }
  }, [timezones, touched]);

  return (
    <form action={action} noValidate aria-label="First-run setup">
      {state.message ? (
        <AlertBanner tone="error" style={{ marginBottom: 14 }}>
          {state.message}
        </AlertBanner>
      ) : null}
      <AuthField
        name="setupToken"
        label="Setup token"
        autoComplete="off"
        mono
        error={errors['setupToken']}
        hint="printed in the API log on first start (or OCSO_SETUP_TOKEN)"
        autoFocus
      />
      <AuthField name="orgName" label="Organization name" autoComplete="organization" defaultValue={values['orgName'] ?? ''} error={errors['orgName']} />
      <div className="fld-row">
        <AuthField name="adminName" label="Your name" autoComplete="name" defaultValue={values['adminName'] ?? ''} error={errors['adminName']} />
        <AuthField
          name="adminEmail"
          label="Work email"
          type="email"
          autoComplete="username"
          defaultValue={values['adminEmail'] ?? ''}
          error={errors['adminEmail']}
        />
      </div>
      <AuthField
        name="adminPassword"
        label="Password"
        type="password"
        autoComplete="new-password"
        error={errors['adminPassword']}
        hint="at least 12 characters"
      />
      <div className="auth-field">
        <label htmlFor="timezone">Deployment timezone</label>
        <select
          id="timezone"
          name="timezone"
          value={timezone}
          onChange={(e) => {
            setTouched(true);
            setTimezone(e.target.value);
          }}
          className="tz-select"
          aria-invalid={errors['timezone'] ? true : undefined}
        >
          {timezones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      </div>
      <button className="btn accent" type="submit" disabled={pending} style={{ marginTop: 4 }}>
        {pending ? 'Creating administrator…' : 'Create administrator'}
      </button>
    </form>
  );
}
