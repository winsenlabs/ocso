'use client';

import { useEffect, useState } from 'react';
import type { CheckerChoice } from '@/components/approvals/lib/schemas';
import { checkerChoiceAction } from '@/lib/actions/approvals';
import { APPROVAL_CHECKER_FIELD, APPROVAL_REASON_FIELD, APPROVAL_SELF, SETTINGS_OBJECT_ID } from './lib/settings-approval';

/**
 * Who approves a settings change, and why (PM/research/11 §4: the deployment settings are always live, so
 * every change is a proposal). Rendered inside each settings form; the form action reads the two fields.
 */
export function SettingsApprovalFields({ idPrefix, errors = {} }: { idPrefix: string; errors?: Record<string, string> | undefined }) {
  const [choice, setChoice] = useState<CheckerChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void checkerChoiceAction('deployment_settings', SETTINGS_OBJECT_ID).then((r) => {
      if (!live) return;
      if (r.ok) setChoice(r.data);
      else setError(r.message);
    });
    return () => {
      live = false;
    };
  }, []);
  const nobody = choice !== null && choice.checkers.length === 0 && !choice.bootstrapAllowed;
  return (
    <fieldset className="conn-fieldset" aria-label="Approval">
      <legend>Approval · a second person approves settings changes</legend>
      {error ? <span className="err-text">{error}</span> : null}
      {nobody ? <span className="warn-text">Nobody can approve settings changes yet: it needs someone else with approval rights for platform settings.</span> : null}
      <div className="fld-row">
        <div className="fld">
          <label htmlFor={`${idPrefix}-checker`}>Checker</label>
          <select id={`${idPrefix}-checker`} name={APPROVAL_CHECKER_FIELD} defaultValue="" aria-invalid={errors[APPROVAL_CHECKER_FIELD] ? true : undefined}>
            <option value="" disabled>
              {choice === null && !error ? 'Loading who can approve…' : 'Choose a checker'}
            </option>
            {(choice?.checkers ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            {choice?.bootstrapAllowed ? <option value={APPROVAL_SELF}>Approve it myself — nobody else can check it (bootstrap, reported)</option> : null}
          </select>
          {errors[APPROVAL_CHECKER_FIELD] ? (
            <span className="err" role="alert">
              {errors[APPROVAL_CHECKER_FIELD]}
            </span>
          ) : null}
        </div>
        <div className="fld">
          <label htmlFor={`${idPrefix}-reason`}>Reason</label>
          <input id={`${idPrefix}-reason`} name={APPROVAL_REASON_FIELD} maxLength={500} autoComplete="off" placeholder="Why this change, for the checker and the audit log" aria-invalid={errors[APPROVAL_REASON_FIELD] ? true : undefined} />
          {errors[APPROVAL_REASON_FIELD] ? (
            <span className="err" role="alert">
              {errors[APPROVAL_REASON_FIELD]}
            </span>
          ) : null}
        </div>
      </div>
    </fieldset>
  );
}
