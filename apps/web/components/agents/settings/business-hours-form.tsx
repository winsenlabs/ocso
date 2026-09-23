'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { SubmitForApprovalModal } from '@/components/approvals/submit-modal';
import { updateBusinessHoursAction } from '@/lib/actions/agents';
import { DAY_LABELS, WEEKDAYS, localIssues, toForm, toInput, type BusinessHours, type HoursForm, type HoursIssues, type Weekday } from '../lib/business-hours';

/**
 * Business hours editor (AGENTS_MANAGE). The AI answers 24×7; these hours say
 * when humans take handoffs. The API validates the zone and every span; its
 * errors are shown next to the field they belong to.
 */
export function BusinessHoursForm({ agentId, hours, timeZones }: { agentId: string; hours: BusinessHours; timeZones: string[] }) {
  const [form, setForm] = useState<HoursForm>(() => toForm(hours));
  const [issues, setIssues] = useState<HoursIssues>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  // A live agent's hours change through a proposal (PM/research/11 §4): the API answers approval_required.
  const [needsApproval, setNeedsApproval] = useState(false);
  const [proposed, setProposed] = useState(false);

  const setDay = (day: Weekday, patch: Partial<HoursForm['days'][Weekday]>) => setForm((f) => ({ ...f, days: { ...f.days, [day]: { ...f.days[day], ...patch } } }));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaved(false);
    setError(null);
    const local = localIssues(form);
    setIssues(local);
    if (Object.keys(local).length) return;
    start(async () => {
      try {
        const result = await updateBusinessHoursAction(agentId, toInput(form));
        if (result.ok) {
          setSaved(true);
          return;
        }
        if (result.code === 'approval_required') {
          setNeedsApproval(true);
          return;
        }
        setIssues(result.fields);
        setError(result.message || (Object.keys(result.fields).length ? null : 'Could not save business hours.'));
      } catch {
        setError('Something went wrong. Try again.');
      }
    });
  }

  return (
    <form className="agent-form" onSubmit={submit} aria-label="Business hours" noValidate>
      <fieldset className="agent-fieldset">
        <legend>Business hours · when humans take handoffs</legend>
        {error ? <AlertBanner tone="error" style={{ margin: 0 }}>{error}</AlertBanner> : null}
        {saved && !pending ? <AlertBanner style={{ margin: 0 }}>Business hours saved · new handoffs follow them right away.</AlertBanner> : null}
        {proposed ? <AlertBanner style={{ margin: 0 }}>Sent for approval · the hours change once the checker approves.</AlertBanner> : null}
        {needsApproval ? (
          <SubmitForApprovalModal
            target={{ objectKind: 'agent', objectId: agentId, title: 'Change business hours', changes: 'business hours' }}
            onClose={() => setNeedsApproval(false)}
            submit={async (approval) => {
              const r = await updateBusinessHoursAction(agentId, toInput(form), approval);
              // A bootstrap approval applies at once; a named checker still has to approve.
              if (r.ok) ('bootstrap' in approval ? setSaved(true) : setProposed(true));
              return r.ok ? { ok: true } : { ok: false, message: r.message };
            }}
          />
        ) : null}
        <p className="mono-sm" style={{ margin: 0 }}>
          The AI answers 24×7. Outside these hours a handoff still joins its queue for pickup, but auto-assign offers and the pickup SLA start at the next opening, and the
          customer is told when the team is back.
        </p>
        <div className="fld" style={{ maxWidth: 380 }}>
          <label htmlFor="bh-tz">Time zone</label>
          <select
            id="bh-tz"
            value={form.timezone}
            aria-invalid={issues.timezone ? true : undefined}
            aria-describedby={issues.timezone ? 'bh-tz-err' : undefined}
            onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
          >
            {timeZones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
          {issues.timezone ? (
            <span className="err" id="bh-tz-err">
              {issues.timezone}
            </span>
          ) : (
            <span className="hint">times below are local to this zone, daylight saving included</span>
          )}
        </div>
        <label className="toggle-row">
          <input type="checkbox" checked={form.alwaysOpen} onChange={(e) => setForm((f) => ({ ...f, alwaysOpen: e.target.checked }))} /> Humans available 24×7
        </label>
        {form.alwaysOpen ? null : (
          <div className="hours-grid" role="group" aria-label="Human hours by day" aria-describedby={issues.days ? 'bh-days-err' : undefined}>
            {WEEKDAYS.map((d) => (
              <DayRow key={d} day={d} value={form.days[d]} error={issues[d]} onChange={(patch) => setDay(d, patch)} />
            ))}
          </div>
        )}
        {issues.days ? (
          <span className="err-text" id="bh-days-err" role="alert">
            {issues.days}
          </span>
        ) : null}
      </fieldset>
      <div className="actions">
        <button type="submit" className="btn accent" disabled={pending}>
          {pending ? 'Saving…' : 'Save business hours'}
        </button>
        <span className="mono-sm">recorded in the audit log</span>
      </div>
    </form>
  );
}

function DayRow({ day, value, error, onChange }: { day: Weekday; value: HoursForm['days'][Weekday]; error: string | undefined; onChange: (patch: Partial<HoursForm['days'][Weekday]>) => void }) {
  const label = DAY_LABELS[day];
  const errId = `bh-${day}-err`;
  return (
    <div className="hours-row" data-day={day}>
      <label className="toggle-row">
        <input type="checkbox" checked={value.open} onChange={(e) => onChange({ open: e.target.checked })} /> {label}
      </label>
      {value.open ? (
        <>
          <input
            type="time"
            step={60}
            aria-label={`${label} opens`}
            value={value.from}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errId : undefined}
            onChange={(e) => onChange({ from: e.target.value })}
          />
          <span className="mono-sm" aria-hidden="true">
            to
          </span>
          <input
            type="time"
            step={60}
            aria-label={`${label} closes`}
            value={value.to === '24:00' ? '23:59' : value.to}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errId : undefined}
            onChange={(e) => onChange({ to: e.target.value })}
          />
        </>
      ) : (
        <span className="mono-sm closed">closed · AI only</span>
      )}
      {error ? (
        <span className="err-text" id={errId}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
