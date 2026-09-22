'use client';

import { setAgentStatusAction } from '@/lib/actions/agents';
import { ConfirmButton } from '../shared/confirm-button';

/** Pause a live agent, or take a draft/paused agent live (needs a model profile and an active prompt). */
export function AgentStatusButton({ agentId, name, status }: { agentId: string; name: string; status: 'DRAFT' | 'LIVE' | 'PAUSED' }) {
  if (status === 'LIVE') {
    return (
      <ConfirmButton label="Pause agent" title={`Pause ${name}`} confirmLabel="Pause agent" tone="danger" run={() => setAgentStatusAction(agentId, 'PAUSED')}>
        {name} stops answering new customer messages. Conversations already with a human are not affected. You can take it live again at any time.
      </ConfirmButton>
    );
  }
  return (
    <ConfirmButton label="Go live" title={`Take ${name} live`} confirmLabel="Go live" run={() => setAgentStatusAction(agentId, 'LIVE')}>
      {name} starts answering customers on its assigned channels with the active prompt version and model profile.
    </ConfirmButton>
  );
}
