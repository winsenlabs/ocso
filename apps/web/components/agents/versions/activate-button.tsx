'use client';

import { activateVersionAction } from '@/lib/actions/agents';
import { ConfirmButton } from '../shared/confirm-button';

/** Activate a newer version, or roll back to an older one (same call; docs/05 §5 invalidates the agent's caches). */
export function ActivateButton({ agentId, versionId, version, liveVersion }: { agentId: string; versionId: string; version: number; liveVersion: number | null }) {
  const rollback = liveVersion !== null && version < liveVersion;
  return (
    <ConfirmButton
      label={rollback ? 'Roll back' : 'Activate'}
      ariaLabel={rollback ? `Roll back to v${version}` : `Activate v${version}`}
      buttonClass="btn tiny"
      title={rollback ? `Roll back to v${version}` : `Activate v${version}`}
      confirmLabel={rollback ? `Roll back to v${version}` : `Activate v${version}`}
      tone={rollback ? 'danger' : 'accent'}
      run={() => activateVersionAction(agentId, versionId)}
    >
      {rollback
        ? `v${version} becomes the live prompt again. Conversations pick it up on their next turn; the cached prompt prefix is rebuilt. v${liveVersion} stays in the history and can be re-activated.`
        : `v${version} becomes the live prompt. Conversations pick it up on their next turn; the cached prompt prefix is rebuilt.${liveVersion !== null ? ` You can roll back to v${liveVersion} at any time.` : ''}`}
    </ConfirmButton>
  );
}
