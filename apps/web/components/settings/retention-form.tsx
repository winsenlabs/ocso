'use client';

import { useActionState } from 'react';
import { SettingsApprovalFields } from './approval-fields';
import { TextField } from '@/components/forms/field';
import { AlertBanner } from '@/components/ui/alert-banner';
import { IDLE } from '@/lib/actions/form-state';
import { updateRetentionAction } from '@/lib/actions/governance';

export interface RetentionRow {
  key: string;
  label: string;
  description: string;
  days: number;
  defaultDays: number;
  minDays: number;
}

/** Retention per data class (docs/15 §8). Logs and traces are retained by their backends, not here. */
export function RetentionForm({ rows, editable }: { rows: RetentionRow[]; editable: boolean }) {
  const [state, action, pending] = useActionState(updateRetentionAction, IDLE);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={action} noValidate className="ch" style={{ gap: 12 }} aria-label="Data retention">
      {state.message ? (
        <AlertBanner tone={state.status === 'error' ? 'error' : 'info'} style={{ margin: 0 }}>
          {state.message}
        </AlertBanner>
      ) : null}
      {rows.map((r) => (
        <TextField
          key={r.key}
          name={`days:${r.key}`}
          type="number"
          label={`${r.label} · days`}
          min={r.minDays}
          max={3650}
          defaultValue={String(r.days)}
          disabled={!editable}
          error={errors[`days:${r.key}`]}
          hint={`${r.description} Default ${r.defaultDays}, minimum ${r.minDays}.`}
        />
      ))}
      <span className="mono-sm">Application logs and traces are kept by the log/trace backend (CloudWatch or the OTel collector); set their retention there.</span>
      {editable ? (
        <SettingsApprovalFields idPrefix="retention" errors={errors} />
      ) : null}
      {editable ? (
        <div className="rowsplit">
          <button type="submit" className="btn accent" disabled={pending}>
            {pending ? 'Submitting…' : 'Submit retention for approval'}
          </button>
          <span className="sp" />
          <span className="mono-sm">applied hourly by the worker · audited</span>
        </div>
      ) : null}
    </form>
  );
}
