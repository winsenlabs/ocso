'use client';

import { useActionState } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { IDLE } from '@/lib/actions/form-state';
import { updateWorkerSettingsAction } from '@/lib/actions/system';
import { WORKER_FORM_FIELDS, displayValue, type WorkerValues } from './worker-form';

/**
 * Edit worker scaling (PATCH /v1/settings/workers). Values are sent as typed;
 * the API validates the merged settings and its messages appear under the
 * offending field. Saving records an audit entry and the worker leader applies
 * the change to the platform within seconds.
 */
export function WorkerConfigForm({ initial }: { initial: WorkerValues }) {
  const [state, action, pending] = useActionState(updateWorkerSettingsAction, IDLE);
  const errors = state.fieldErrors ?? {};
  const value = (name: (typeof WORKER_FORM_FIELDS)[number]['name']) => state.values?.[name] ?? displayValue(initial, name);
  const autoscaling = state.values ? state.values['autoscalingEnabled'] === 'on' : initial.autoscalingEnabled;

  return (
    <form action={action} noValidate className="ch" style={{ gap: 14 }} aria-label="Edit worker configuration" id="worker-config">
      <div className="t">
        <h3>Edit worker configuration</h3>
        <span className="mono-sm">scale on conversation demand and queue age — CPU is a secondary signal only</span>
      </div>
      <div aria-live="polite">
        {state.message ? (
          <AlertBanner tone={state.status === 'error' ? 'error' : 'info'} style={{ margin: 0 }}>
            {state.message}
          </AlertBanner>
        ) : null}
      </div>
      <div className="cfg-form">
        {WORKER_FORM_FIELDS.map((f) => {
          const id = `wk-${f.name}`;
          const error = errors[f.name];
          return (
            <div className="fld" key={f.name}>
              <label htmlFor={id}>
                {f.label} <span className="mono-sm">({f.unit})</span>
              </label>
              <input
                key={`${f.name}-${value(f.name)}`}
                id={id}
                name={f.name}
                type="text"
                inputMode="decimal"
                defaultValue={value(f.name)}
                aria-invalid={error ? true : undefined}
                aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
              />
              <span id={`${id}-hint`} className="hint">
                {f.hint}
              </span>
              {error ? (
                <span id={`${id}-error`} className="err" role="alert">
                  {error}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      <label className="toggle-row">
        <input key={`auto-${String(autoscaling)}`} type="checkbox" name="autoscalingEnabled" defaultChecked={autoscaling} />
        Autoscaling enabled — the deployment adapter moves capacity between min and max
      </label>
      <div className="rowsplit">
        <button type="submit" className="btn accent" disabled={pending}>
          {pending ? 'Saving…' : 'Save configuration'}
        </button>
        <span className="sp" />
        <span className="mono-sm">bounds are enforced by the API · changes are audited and attributed to you</span>
      </div>
    </form>
  );
}
