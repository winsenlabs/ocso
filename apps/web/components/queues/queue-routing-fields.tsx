'use client';

import { toForm, toInput, WEEKDAYS, DAY_LABELS, type HoursForm } from '@/components/agents/lib/business-hours';
import { CheckboxGroup } from '@/components/forms/field';
import type { Option } from './queue-form-modal';

export interface AttributeRow {
  key: string;
  value: string;
}

/**
 * The routing half of the queue dialog (PM/research/11 §5.5, §5.7): the one AI
 * agent, the attributes routers match (key/value), and the queues
 * conversations may be transferred to. Controlled by the dialog.
 */
export function QueueRoutingFields({
  agents,
  agentId,
  attributes,
  onAttributes,
  targets,
  targetIds,
  error,
}: {
  agents: Option[];
  agentId: string;
  attributes: AttributeRow[];
  onAttributes: (rows: AttributeRow[]) => void;
  targets: Option[];
  targetIds: string[];
  error: string | undefined;
}) {
  const set = (i: number, patch: Partial<AttributeRow>) => onAttributes(attributes.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  // The queue's agent may be owned by a team the editor is not in (ADR-026): keep it selectable so a save never clears it.
  const foreignAgent = agentId !== '' && !agents.some((a) => a.value === agentId);
  return (
    <fieldset className="ops-fieldset">
      <legend>Routing</legend>
      <div className="fld">
        <label htmlFor="q-agent">AI agent</label>
        <select id="q-agent" name="agentId" defaultValue={agentId}>
          <option value="">No agent yet (routers cannot use this queue)</option>
          {foreignAgent ? <option value={agentId}>Current agent (owned by another team)</option> : null}
          {agents.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
        <span className="hint">exactly one agent answers every conversation routed here; one agent may serve many queues</span>
      </div>
      <div className="fld">
        <span id="q-attrs-label" style={{ fontSize: 12, color: 'var(--ink-2)', fontWeight: 500 }}>
          Attributes
        </span>
        <div role="group" aria-labelledby="q-attrs-label" style={{ display: 'grid', gap: 6 }}>
          {attributes.map((row, i) => (
            <div key={i} className="rowsplit" style={{ gap: 6 }}>
              <input aria-label={`Attribute ${i + 1} key`} placeholder="language" value={row.key} onChange={(e) => set(i, { key: e.target.value })} />
              <span className="mono-sm">=</span>
              <input aria-label={`Attribute ${i + 1} value`} placeholder="ta" value={row.value} onChange={(e) => set(i, { value: e.target.value })} />
              <button type="button" className="btn tiny ghost" aria-label={`Remove attribute ${i + 1}`} onClick={() => onAttributes(attributes.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
          <button type="button" className="btn tiny" style={{ justifySelf: 'start' }} onClick={() => onAttributes([...attributes, { key: '', value: '' }])}>
            Add attribute
          </button>
        </div>
        {error ? (
          <span className="err" role="alert">
            {error}
          </span>
        ) : (
          <span className="hint">what this queue serves, e.g. language = ta, product = sales — routers’ rules send customers here by these</span>
        )}
      </div>
      {targets.length ? (
        <CheckboxGroup idPrefix="q" name="transferTargetIds" label="May transfer to" options={targets} defaultValues={targetIds} hint="removing a target applies at once; adding one needs approval once the queue is approved" />
      ) : null}
    </fieldset>
  );
}

/** Business hours of the queue's humans: the agent's hours, or the queue's own week. */
export function QueueHoursFields({ hours, onHours }: { hours: HoursForm | null; onHours: (h: HoursForm | null) => void }) {
  const form = hours;
  return (
    <fieldset className="ops-fieldset">
      <legend>Human hours</legend>
      <label className="toggle-row">
        <input type="checkbox" checked={form === null} onChange={(e) => onHours(e.target.checked ? null : toForm({ timezone: 'Asia/Kolkata', humanHours: { mon: ['09:00', '18:00'], tue: ['09:00', '18:00'], wed: ['09:00', '18:00'], thu: ['09:00', '18:00'], fri: ['09:00', '18:00'] } }))} />
        Use the agent’s hours
      </label>
      {form ? (
        <>
          <div className="fld">
            <label htmlFor="q-tz">Time zone</label>
            <input id="q-tz" value={form.timezone} onChange={(e) => onHours({ ...form, timezone: e.target.value })} placeholder="Asia/Kolkata" />
          </div>
          <label className="toggle-row">
            <input type="checkbox" checked={form.alwaysOpen} onChange={(e) => onHours({ ...form, alwaysOpen: e.target.checked })} />
            Humans 24×7
          </label>
          {!form.alwaysOpen ? (
            <div style={{ display: 'grid', gap: 4 }}>
              {WEEKDAYS.map((d) => (
                <div key={d} className="rowsplit" style={{ gap: 8 }}>
                  <label className="toggle-row" style={{ minWidth: 120 }}>
                    <input type="checkbox" checked={form.days[d].open} onChange={(e) => onHours({ ...form, days: { ...form.days, [d]: { ...form.days[d], open: e.target.checked } } })} />
                    {DAY_LABELS[d]}
                  </label>
                  <input type="time" aria-label={`${DAY_LABELS[d]} from`} value={form.days[d].from} disabled={!form.days[d].open} onChange={(e) => onHours({ ...form, days: { ...form.days, [d]: { ...form.days[d], from: e.target.value } } })} />
                  <input type="time" aria-label={`${DAY_LABELS[d]} to`} value={form.days[d].to} disabled={!form.days[d].open} onChange={(e) => onHours({ ...form, days: { ...form.days, [d]: { ...form.days[d], to: e.target.value } } })} />
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <span className="mono-sm">handoffs follow the hours set on the agent</span>
      )}
    </fieldset>
  );
}

export { toForm as hoursToForm, toInput as hoursToInput };
