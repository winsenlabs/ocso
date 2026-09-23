'use client';

import { ApprovableButton } from '@/components/approvals/approvable-button';
import { setAgentStatusAction } from '@/lib/actions/agents';
import { ConfirmButton } from '../shared/confirm-button';

/**
 * Pause a live agent (immediate: a stop action, never gated), or take a
 * draft/paused agent live — always a maker–checker proposal: the button asks
 * for a checker and a reason (PM/research/11 §4).
 */
export function AgentStatusButton({ agentId, name, status, canPause, canManage, pending }: { agentId: string; name: string; status: 'DRAFT' | 'LIVE' | 'PAUSED'; canPause: boolean; canManage: boolean; pending: boolean }) {
  if (status === 'LIVE') {
    if (!canPause) return null;
    return (
      <ConfirmButton label="Pause agent" title={`Pause ${name}`} confirmLabel="Pause agent" tone="danger" run={() => setAgentStatusAction(agentId, 'PAUSED')}>
        {name} stops answering new customer messages at once. Conversations already with a human are not affected. Taking it live again needs approval.
      </ConfirmButton>
    );
  }
  if (!canManage) return null;
  const resume = status === 'PAUSED';
  return (
    <ApprovableButton
      label={resume ? 'Resume' : 'Go live'}
      title={resume ? `Resume ${name}` : `Take ${name} live`}
      confirmLabel="Submit for approval"
      target={{ objectKind: 'agent', objectId: agentId, title: resume ? `Resume ${name}` : `Take ${name} live` }}
      write={(approval) => setAgentStatusAction(agentId, 'LIVE', approval)}
      always
      disabled={pending}
    >
      {name} starts answering customers with the active prompt version and model profile once a checker approves.
    </ApprovableButton>
  );
}
