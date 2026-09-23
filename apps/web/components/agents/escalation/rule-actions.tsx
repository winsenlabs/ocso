'use client';

import { useState } from 'react';
import { deleteRuleAction, saveRuleAction } from '@/lib/actions/agents';
import type { EscalationRule } from '../data/agent-schemas';
import type { Option } from '../data/options';
import { ConfirmButton } from '../shared/confirm-button';
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

/** Edit, switch on/off and delete one agent-scoped rule. */
export function RuleActions({ agentId, rule, queues }: { agentId: string; rule: EscalationRule; queues: Option[] | null }) {
  const [editing, setEditing] = useState(false);
  const toggle = useAgentAction();
  return (
    <span className="vacts" style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
      <button type="button" className="btn tiny ghost" onClick={() => setEditing(true)} aria-label={`Edit ${rule.name}`}>
        Edit
      </button>
      <button
        type="button"
        className="btn tiny ghost"
        disabled={toggle.pending}
        onClick={() => toggle.run(() => saveRuleAction(agentId, rule.id, { enabled: !rule.enabled }))}
        aria-label={`${rule.enabled ? 'Turn off' : 'Turn on'} ${rule.name}`}
        title={toggle.error ?? undefined}
      >
        {rule.enabled ? 'Turn off' : 'Turn on'}
      </button>
      <ConfirmButton label="Delete" ariaLabel={`Delete ${rule.name}`} buttonClass="btn tiny ghost" title={`Delete "${rule.name}"`} confirmLabel="Delete rule" tone="danger" run={() => deleteRuleAction(agentId, rule.id)}>
        The rule stops triggering handoffs for this agent. The deletion is recorded in the audit log; recreate it to bring it back.
      </ConfirmButton>
      {toggle.error ? (
        <span className="err-text" role="alert">
          {toggle.error}
        </span>
      ) : null}
      {editing ? <RuleDialog agentId={agentId} rule={rule} queues={queues} onClose={() => setEditing(false)} /> : null}
    </span>
  );
}
