'use client';

import { useState } from 'react';
import { ApprovableButton } from '@/components/approvals/approvable-button';
import { PendingBadge } from '@/components/approvals/pending-badge';
import { deleteRuleAction, setRuleEnabledAction } from '@/lib/actions/agent-config';
import type { EscalationRule } from '../data/agent-schemas';
import type { Option } from '../data/options';
import { useAgentAction } from '../shared/use-action';
import { RuleDialog } from './rule-dialog';

export function AddRuleButton({ agentId, queues }: { agentId: string; queues: Option[] | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn tiny" onClick={() => setOpen(true)}>
        Add rule
      </button>
      {open ? <RuleDialog agentId={agentId} rule={null} queues={queues} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * One agent-scoped rule (PM/research/11 §4): turning it on and deleting it are
 * always proposals (a checker approves); turning it off is immediate, even while
 * a proposal waits; editing is direct for a draft and a proposal once approved.
 */
export function RuleActions({ agentId, rule, queues }: { agentId: string; rule: EscalationRule; queues: Option[] | null }) {
  const [editing, setEditing] = useState(false);
  const off = useAgentAction();
  const pending = rule.approval.pending;
  return (
    <span className="vacts" style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', flexWrap: 'wrap', alignItems: 'center' }}>
      {pending ? <PendingBadge state={{ approved: rule.approval.approved, pending, updateNeedsApproval: true, checkPermission: 'approvals.check.agents' }} /> : null}
      <button type="button" className="btn tiny ghost" onClick={() => setEditing(true)} aria-label={`Edit ${rule.name}`} disabled={Boolean(pending)} title={pending ? 'A change is waiting for approval' : undefined}>
        Edit
      </button>
      {rule.enabled ? (
        <button type="button" className="btn tiny ghost" disabled={off.pending} onClick={() => off.run(() => setRuleEnabledAction(agentId, rule.id, false))} aria-label={`Turn off ${rule.name}`}>
          Turn off
        </button>
      ) : (
        <ApprovableButton
          always
          label="Turn on"
          ariaLabel={`Turn on ${rule.name}`}
          buttonClass="btn tiny ghost"
          title={`Turn on ${rule.name}`}
          confirmLabel="Turn on"
          disabled={Boolean(pending)}
          target={{ objectKind: 'escalation_rule', objectId: rule.id, title: `Turn on escalation rule "${rule.name}"` }}
          write={(approval) => setRuleEnabledAction(agentId, rule.id, true, approval)}
        >
          The rule starts triggering handoffs once a checker approves it.
        </ApprovableButton>
      )}
      <ApprovableButton
        always
        label="Delete"
        ariaLabel={`Delete ${rule.name}`}
        buttonClass="btn tiny ghost"
        tone="danger"
        title={`Delete "${rule.name}"`}
        confirmLabel="Delete rule"
        disabled={Boolean(pending)}
        target={{ objectKind: 'escalation_rule', objectId: rule.id, title: `Delete escalation rule "${rule.name}"` }}
        write={(approval) => deleteRuleAction(agentId, rule.id, approval)}
      >
        The rule stops triggering handoffs for this agent once a checker approves the deletion.
      </ApprovableButton>
      {off.error ? (
        <span className="err-text" role="alert">
          {off.error}
        </span>
      ) : null}
      {editing ? <RuleDialog agentId={agentId} rule={rule} queues={queues} onClose={() => setEditing(false)} /> : null}
    </span>
  );
}
