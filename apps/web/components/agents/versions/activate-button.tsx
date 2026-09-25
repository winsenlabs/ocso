'use client';

import { ApprovableButton } from '@/components/approvals/approvable-button';
import { activateVersionAction } from '@/lib/actions/agents';

/**
 * Activate a newer version, or roll back to an older one (same call; docs/archive/specs/05 §5 invalidates the agent's caches).
 * A draft agent's prompt activates at once; once the agent is live configuration it is a proposal for a checker.
 */
export function ActivateButton({ agentId, agentName, versionId, version, liveVersion }: { agentId: string; agentName?: string; versionId: string; version: number; liveVersion: number | null }) {
  const rollback = liveVersion !== null && version < liveVersion;
  return (
    <ApprovableButton
      label={rollback ? 'Roll back' : 'Activate'}
      ariaLabel={rollback ? `Roll back to v${version}` : `Activate v${version}`}
      buttonClass="btn tiny"
      title={rollback ? `Roll back to v${version}` : `Activate v${version}`}
      confirmLabel={rollback ? `Roll back to v${version}` : `Activate v${version}`}
      tone={rollback ? 'danger' : 'accent'}
      target={{ objectKind: 'prompt_version', objectId: versionId, title: `Activate prompt v${version}${agentName ? ` for ${agentName}` : ''}` }}
      write={(approval) => activateVersionAction(agentId, versionId, approval)}
    >
      {rollback
        ? `v${version} becomes the live prompt again. Conversations pick it up on their next turn; the cached prompt prefix is rebuilt. v${liveVersion} stays in the history and can be re-activated.`
        : `v${version} becomes the live prompt. Conversations pick it up on their next turn; the cached prompt prefix is rebuilt.${liveVersion !== null ? ` You can roll back to v${liveVersion} at any time.` : ''}`}{' '}
      Once the agent is live, this needs a checker’s approval.
    </ApprovableButton>
  );
}
