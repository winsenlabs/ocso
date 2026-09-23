'use client';

import { useActionState } from 'react';
import { SelectField, TextField } from '@/components/forms/field';
import { AlertBanner } from '@/components/ui/alert-banner';
import { IDLE } from '@/lib/actions/form-state';
import { updateDeploymentAction } from '@/lib/actions/settings';

export interface DeploymentFormValues {
  orgName: string;
  deploymentLabel: string;
  regionLabel: string;
  timezone: string;
  residencyZone: string;
  execsCanViewAiActive: boolean;
  allowCrossProviderFallback: boolean;
  allowCrossRegionFallback: boolean;
}

const TOGGLES: Array<{ name: keyof DeploymentFormValues; label: string }> = [
  { name: 'execsCanViewAiActive', label: 'Service members can view AI-active conversations' },
  { name: 'allowCrossProviderFallback', label: 'Allow fallback to a different model provider' },
  { name: 'allowCrossRegionFallback', label: 'Allow fallback to a different region' },
];

/** Deployment settings form for the Tech admin → PATCH /v1/settings/deployment. */
export function DeploymentForm({ initial, timezones }: { initial: DeploymentFormValues; timezones: string[] }) {
  const [state, action, pending] = useActionState(updateDeploymentAction, IDLE);
  const errors = state.fieldErrors ?? {};
  const v = (name: keyof DeploymentFormValues) => state.values?.[name] ?? String(initial[name]);
  const zones = timezones.includes(initial.timezone) ? timezones : [initial.timezone, ...timezones];

  return (
    <form action={action} noValidate className="ch" style={{ gap: 14 }} aria-label="Deployment settings">
      {state.message ? (
        <AlertBanner tone={state.status === 'error' ? 'error' : 'info'} style={{ margin: 0 }}>
          {state.message}
        </AlertBanner>
      ) : null}
      <div className="fld-row">
        <TextField name="orgName" label="Organization name" defaultValue={v('orgName')} error={errors['orgName']} required />
        <TextField name="deploymentLabel" label="Deployment label" defaultValue={v('deploymentLabel')} error={errors['deploymentLabel']} hint="shown in the sidebar, e.g. PROD or UAT" required />
      </div>
      <div className="fld-row">
        <TextField name="regionLabel" label="Region label" defaultValue={v('regionLabel')} error={errors['regionLabel']} hint="e.g. ap-south-1 · optional" />
        <TextField name="residencyZone" label="Data residency zone" defaultValue={v('residencyZone')} error={errors['residencyZone']} hint="e.g. IN · optional" />
      </div>
      <SelectField name="timezone" label="Deployment timezone" options={zones.map((z) => ({ value: z, label: z }))} defaultValue={v('timezone')} error={errors['timezone']} hint="all operational times render in this zone" />
      <fieldset style={{ border: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
        <legend className="sr-only">Policies</legend>
        {TOGGLES.map((t) => (
          <label key={t.name} className="toggle-row">
            <input type="checkbox" name={t.name} defaultChecked={initial[t.name] === true} />
            {t.label}
          </label>
        ))}
      </fieldset>
      <div className="rowsplit">
        <button type="submit" className="btn accent" disabled={pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </button>
        <span className="sp" />
        <span className="mono-sm">changes are audited and attributed to you</span>
      </div>
    </form>
  );
}
