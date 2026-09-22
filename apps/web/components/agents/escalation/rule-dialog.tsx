'use client';

import { useState, type FormEvent } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { saveRuleAction } from '@/lib/actions/agents';
import { ESCALATION_TRIGGERS, PRIORITIES, type EscalationRule } from '../data/agent-schemas';
import type { Option } from '../data/options';
import { TRIGGER_LABELS } from '../lib/labels';
import { buildCondition } from '../lib/rules';
import { useAgentAction } from '../shared/use-action';

interface Props {
  agentId: string;
  rule: EscalationRule | null;
  queues: Option[] | null;
  onClose: () => void;
}

/**
 * Deterministic escalation rule (docs/01 §6): conditions are evaluated in
 * code; the prompt's Escalation component covers judgement calls.
 */
export function RuleDialog({ agentId, rule, queues, onClose }: Props) {
  const action = useAgentAction();
  const [local, setLocal] = useState<string | null>(null);
  const c = rule?.condition ?? {};

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '');
    const built = buildCondition({
      keywords: text('keywords'),
      consecutiveToolFailures: text('consecutiveToolFailures'),
      customerRequestsHuman: f.get('customerRequestsHuman') === 'on',
      amountAbove: text('amountAbove'),
    });
    if (!built.ok) {
      setLocal(built.message);
      return;
    }
    setLocal(null);
    const body = {
      name: text('name'),
      trigger: text('trigger') as (typeof ESCALATION_TRIGGERS)[number],
      condition: built.condition,
      mode: text('mode') as EscalationRule['mode'],
      targetQueueId: text('targetQueueId') || null,
      priority: text('priority') as EscalationRule['priority'],
      enabled: f.get('enabled') === 'on',
    };
    action.run(() => saveRuleAction(agentId, rule?.id ?? null, body), onClose);
  }

  const error = local ?? action.error;
  return (
    <Modal
      title={rule ? `Edit rule · ${rule.name}` : 'Add escalation rule'}
      sub="applies to this agent · audited"
      onClose={() => !action.pending && onClose()}
      maxWidth={620}
      footer={
        <>
          <span className="sp" />
          <button type="button" className="btn" onClick={onClose} disabled={action.pending}>
            Cancel
          </button>
          <button type="submit" form="rule-form" className="btn accent" disabled={action.pending}>
            {action.pending ? 'Saving…' : rule ? 'Save rule' : 'Add rule'}
          </button>
        </>
      }
    >
      <form id="rule-form" className="agent-form" onSubmit={submit}>
        {error ? <AlertBanner tone="error" style={{ margin: 0 }}>{error}</AlertBanner> : null}
        <div className="fld-row">
          <div className="fld">
            <label htmlFor="er-name">Rule name</label>
            <input id="er-name" name="name" required maxLength={120} defaultValue={rule?.name ?? ''} placeholder="Refund amount above ₹5,000" data-autofocus />
          </div>
          <div className="fld">
            <label htmlFor="er-trigger">Trigger</label>
            <select id="er-trigger" name="trigger" defaultValue={rule?.trigger ?? 'BUSINESS_RULE'}>
              {ESCALATION_TRIGGERS.map((t) => (
                <option key={t} value={t}>
                  {TRIGGER_LABELS[t] ?? t}
                </option>
              ))}
            </select>
          </div>
        </div>
        <fieldset className="agent-fieldset">
          <legend>Conditions · any that apply</legend>
          <div className="fld">
            <label htmlFor="er-keywords">Keywords</label>
            <input id="er-keywords" name="keywords" defaultValue={c.keywords?.join(', ') ?? ''} placeholder="hardship, job loss, bereavement" />
            <span className="hint">comma-separated · matched in customer messages</span>
          </div>
          <div className="fld-row">
            <div className="fld">
              <label htmlFor="er-failures">Consecutive tool failures</label>
              <input id="er-failures" name="consecutiveToolFailures" type="number" min={1} max={10} defaultValue={c.consecutiveToolFailures ?? ''} />
            </div>
            <div className="fld">
              <label htmlFor="er-amount">Amount above</label>
              <input id="er-amount" name="amountAbove" type="number" min={0} step="any" defaultValue={c.amountAbove ?? ''} />
            </div>
          </div>
          <label className="toggle-row">
            <input type="checkbox" name="customerRequestsHuman" defaultChecked={c.customerRequestsHuman ?? false} /> Customer asks for a human
          </label>
        </fieldset>
        <div className="fld-row">
          <div className="fld">
            <label htmlFor="er-mode">Handoff mode</label>
            <select id="er-mode" name="mode" defaultValue={rule?.mode ?? 'OPEN_PICKUP'}>
              <option value="OPEN_PICKUP">Open pickup</option>
              <option value="AUTO_ASSIGN">Auto-assign</option>
            </select>
          </div>
          <div className="fld">
            <label htmlFor="er-priority">Priority</label>
            <select id="er-priority" name="priority" defaultValue={rule?.priority ?? 'P3'}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="fld">
          <label htmlFor="er-queue">Target queue</label>
          <select id="er-queue" name="targetQueueId" defaultValue={rule?.targetQueueId ?? ''} disabled={!queues}>
            <option value="">Agent&apos;s default queue</option>
            {queues?.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </select>
        </div>
        <label className="toggle-row">
          <input type="checkbox" name="enabled" defaultChecked={rule?.enabled ?? true} /> Rule is on
        </label>
      </form>
    </Modal>
  );
}
