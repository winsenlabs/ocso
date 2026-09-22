'use client';

import { useState } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { RULE_OPS, type ArgumentRule, type RuleOp } from '../data/agent-schemas';
import { OP_LABELS, buildRule, describeRule } from '../lib/rules';

interface Props {
  toolName: string;
  rules: ArgumentRule[];
  onApply: (rules: ArgumentRule[]) => void;
  onClose: () => void;
}

const EMPTY = { path: '', op: 'gt' as RuleOp, value: '', effect: 'REQUIRE_CONFIRMATION' as ArgumentRule['effect'], message: '' };

/**
 * Deterministic argument policy for one tool (docs/08 §6): e.g. require a
 * human confirmation when amount > 5000, or deny a field value outright.
 * Applied to the grant locally; "Save tool grants" persists it.
 */
export function ArgumentRulesDialog({ toolName, rules, onApply, onClose }: Props) {
  const [list, setList] = useState<ArgumentRule[]>(rules);
  const [draft, setDraft] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);

  function add() {
    const built = buildRule(draft);
    if (!built.ok) {
      setError(built.message);
      return;
    }
    if (list.length >= 20) {
      setError('At most 20 argument rules per tool');
      return;
    }
    setError(null);
    setList((prev) => [...prev, built.rule]);
    setDraft(EMPTY);
  }

  return (
    <Modal
      title={`Argument rules · ${toolName}`}
      sub="checked in code before every call"
      onClose={onClose}
      maxWidth={720}
      footer={
        <>
          <span className="mono-sm">applied on “Save tool grants”</span>
          <span className="sp" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn accent"
            onClick={() => {
              onApply(list);
              onClose();
            }}
          >
            Apply rules
          </button>
        </>
      }
    >
      <div className="agent-form">
        {list.length ? (
          <div className="dtable" role="list" aria-label="Current argument rules">
            {list.map((r, i) => (
              <div className="dt-row" role="listitem" key={`${r.path}-${i}`} style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                <span>
                  <span className="mono" style={{ fontSize: 12 }}>
                    {describeRule(r)}
                  </span>
                  <span className="mono-sm row-note">“{r.message}”</span>
                </span>
                <button type="button" className="btn tiny ghost" onClick={() => setList((prev) => prev.filter((_, j) => j !== i))} aria-label={`Remove rule on ${r.path}`}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="mono-sm" style={{ margin: 0 }}>
            No rules: every call the model makes goes through as the tool&apos;s risk class allows.
          </p>
        )}
        <fieldset className="agent-fieldset">
          <legend>Add a rule</legend>
          {error ? <AlertBanner tone="error" style={{ margin: 0 }}>{error}</AlertBanner> : null}
          <div className="rule-grid">
            <div className="fld">
              <label htmlFor="ar-path">Argument</label>
              <input id="ar-path" value={draft.path} onChange={(e) => setDraft({ ...draft, path: e.target.value })} placeholder="amount" />
            </div>
            <div className="fld">
              <label htmlFor="ar-op">Operator</label>
              <select id="ar-op" value={draft.op} onChange={(e) => setDraft({ ...draft, op: e.target.value as RuleOp })}>
                {RULE_OPS.map((op) => (
                  <option key={op} value={op}>
                    {OP_LABELS[op]}
                  </option>
                ))}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="ar-value">Value</label>
              <input id="ar-value" value={draft.value} disabled={draft.op === 'exists'} onChange={(e) => setDraft({ ...draft, value: e.target.value })} placeholder={draft.op === 'in' || draft.op === 'not_in' ? 'a, b, c' : '5000'} />
            </div>
            <div className="fld">
              <label htmlFor="ar-effect">Effect</label>
              <select id="ar-effect" value={draft.effect} onChange={(e) => setDraft({ ...draft, effect: e.target.value as ArgumentRule['effect'] })}>
                <option value="REQUIRE_CONFIRMATION">Require confirmation</option>
                <option value="DENY">Deny</option>
              </select>
            </div>
            <span />
          </div>
          <div className="fld">
            <label htmlFor="ar-message">Message</label>
            <input id="ar-message" value={draft.message} maxLength={300} onChange={(e) => setDraft({ ...draft, message: e.target.value })} placeholder="Refunds above ₹5,000 need a human to confirm" />
            <span className="hint">shown to the person who confirms, and to the agent when a call is denied</span>
          </div>
          <div>
            <button type="button" className="btn tiny" onClick={add}>
              Add rule
            </button>
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}
