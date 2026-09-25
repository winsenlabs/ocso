'use client';

import { useState, type FormEvent } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { useApprovalRequest } from '@/components/approvals/use-approval-request';
import { saveRuleAction } from '@/lib/actions/agent-config';
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
 * Deterministic escalation rule (docs/archive/specs/01 §6): conditions are evaluated in
 * code; the prompt's Escalation component covers judgement calls.
 */
export function RuleDialog({ agentId, rule, queues, onClose }: Props) {
  const action = useAgentAction();
  // An approved rule's change is a proposal: the same Save continues into the submit-for-approval modal.
  const approval = useApprovalRequest();
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
    };
    if (!rule) {
      action.run(() => saveRuleAction(agentId, null, body), onClose);
      return;
    }
    approval.run({ objectKind: 'escalation_rule', objectId: rule.id, title: `Change escalation rule "${rule.name}"` }, (choice) => saveRuleAction(agentId, rule.id, body, choice), { onApplied: onClose });
  }

  const error = local ?? action.error ?? approval.error;
  const busy = action.pending || approval.pending;
  return (
    <Modal
      title={rule ? `Edit rule · ${rule.name}` : 'Add escalation rule'}
      sub="applies to this agent · audited"
      onClose={() => !busy && onClose()}
      maxWidth={620}
      footer={
        <>
          <span className="sp" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {approval.outcome ? 'Close' : 'Cancel'}
          </button>
          <button type="submit" form="rule-form" className="btn accent" disabled={busy || approval.outcome !== null}>
            {busy ? 'Saving…' : rule ? 'Save rule' : 'Add rule'}
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
              <span className="hint">an amount with a currency in customer messages · ₹75,000 · Rs 6,000</span>
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
        <p className="mono-sm" style={{ margin: 0 }}>
          {rule
            ? rule.approval.approved
              ? 'This rule has been approved: saving sends the change to a checker; nothing changes until they approve.'
              : 'A draft: saved directly. It stays off until a checker approves turning it on.'
            : 'A new rule starts off. Turn it on from the list; a checker approves it.'}
        </p>
      </form>
      {approval.notice ? (
        <AlertBanner tone="info" style={{ margin: '10px 0 0' }}>
          {approval.notice}
        </AlertBanner>
      ) : null}
      {approval.modal}
    </Modal>
  );
}
