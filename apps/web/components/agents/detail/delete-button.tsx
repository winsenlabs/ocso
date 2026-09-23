'use client';

import { ApprovableButton } from '@/components/approvals/approvable-button';
import { deleteAgentAction } from '@/lib/actions/agents';

/** Propose deleting an agent (agents.delete, Head). Always a maker–checker proposal; a live agent is paused first. */
export function DeleteAgentButton({ agentId, name, pending }: { agentId: string; name: string; pending: boolean }) {
  return (
    <ApprovableButton
      label="Delete"
      title={`Delete ${name}`}
      confirmLabel="Submit for approval"
      tone="danger"
      buttonClass="btn tiny ghost"
      target={{ objectKind: 'agent', objectId: agentId, title: `Delete ${name}` }}
      write={(approval) => deleteAgentAction(agentId, approval)}
      always
      disabled={pending}
    >
      {name} and its prompt versions are removed once a checker approves. An agent that has served conversations cannot be deleted — pause it instead.
    </ApprovableButton>
  );
}
