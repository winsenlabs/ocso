'use client';

import { ApprovableButton } from '@/components/approvals/approvable-button';
import { PendingBadge } from '@/components/approvals/pending-badge';
import type { ObjectApprovalState } from '@/components/approvals/lib/schemas';
import { platformActivateAction, platformDeleteAction, platformStopAction, type PlatformKind } from '@/lib/actions/platform-approvals';
import { ConfirmAction } from './confirm-action';

export interface LifecycleActionsProps {
  kind: PlatformKind;
  /** Object id (what the approval is about). */
  id: string;
  /** Path id when it differs from the object id (SSO providers are addressed by providerId). */
  pathRef?: string | undefined;
  name: string;
  /** draft: never live · live · stopped: disabled after being live. */
  state: 'draft' | 'live' | 'stopped';
  approval?: ObjectApprovalState | null | undefined;
  /** Button words: activate / resume. */
  activateLabel?: string | undefined;
  /** Kinds with an immediate stop (disable). */
  canStop?: boolean | undefined;
  canDelete?: boolean | undefined;
}

/**
 * The maker–checker lifecycle of a platform object (PM/research/11 §4), shared by every Connections and
 * Settings screen: a pending badge while a proposal is open, Activate / Re-enable (always a proposal: the
 * submit modal asks for a checker), Disable (immediate, never locked), Delete (always a proposal).
 */
export function LifecycleActions({ kind, id, pathRef, name, state, approval, activateLabel, canStop = true, canDelete = true }: LifecycleActionsProps) {
  const ref = pathRef ?? id;
  const pending = approval?.pending ?? null;
  const target = (title: string) => ({ objectKind: kind, objectId: id, title });
  const activate = activateLabel ?? (state === 'stopped' ? 'Re-enable' : 'Activate');
  return (
    <span className="lifecycle" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <PendingBadge state={approval} />
      {state !== 'live' && !pending ? (
        <ApprovableButton
          label={activate}
          title={`${activate} ${name}`}
          confirmLabel="Submit for approval"
          target={target(`${activate} ${name}`)}
          write={(choice) => platformActivateAction(kind, ref, choice)}
          always
          buttonClass="btn tiny accent"
          ariaLabel={`${activate} ${name}`}
        >
          {`${name} takes effect once a second person approves it.`}
        </ApprovableButton>
      ) : null}
      {canStop && state === 'live' ? (
        <ConfirmAction label="Disable" title={`Disable ${name}`} confirmLabel="Disable now" buttonClass="btn tiny ghost" run={() => platformStopAction(kind, ref)}>
          Disabling is immediate and needs no approval. Turning it back on is a change a second person approves.
        </ConfirmAction>
      ) : null}
      {canDelete && !pending ? (
        <ApprovableButton
          label="Delete"
          title={`Delete ${name}`}
          confirmLabel="Submit for approval"
          target={target(`Delete ${name}`)}
          write={(choice) => platformDeleteAction(kind, ref, choice)}
          always
          tone="danger"
          buttonClass="btn tiny ghost"
          ariaLabel={`Delete ${name}`}
        >
          {`Deleting ${name} needs a second person’s approval.`}
        </ApprovableButton>
      ) : null}
    </span>
  );
}

/** Delete as a proposal from inside an edit dialog (the same always-a-proposal write as the card's Delete). */
export function DeleteByApproval({ kind, id, pathRef, name, detail, buttonClass = 'btn danger' }: { kind: PlatformKind; id: string; pathRef?: string | undefined; name: string; detail: string; buttonClass?: string }) {
  return (
    <ApprovableButton
      label="Delete"
      title={`Delete ${name}`}
      confirmLabel="Submit for approval"
      target={{ objectKind: kind, objectId: id, title: `Delete ${name}` }}
      write={(choice) => platformDeleteAction(kind, pathRef ?? id, choice)}
      always
      tone="danger"
      buttonClass={buttonClass}
      ariaLabel={`Delete ${name}`}
    >
      {detail}
    </ApprovableButton>
  );
}
