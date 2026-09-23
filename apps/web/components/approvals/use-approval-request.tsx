'use client';

import { useCallback, useState, useTransition, type ReactNode } from 'react';
import { SubmitForApprovalModal, type ApprovalChoice, type ApprovalTarget } from './submit-modal';

type Result<T> = { ok: true; data: T } | { ok: false; message: string; code?: string | undefined };
type Write<T> = (approval?: ApprovalChoice) => Promise<Result<T>>;

export interface ApprovalRequestState {
  pending: boolean;
  error: string | null;
  /** "Sent for approval…" after a proposal was created. */
  notice: string | null;
  /** How the last submitted write ended: waiting for a checker, or approved and applied by a bootstrap. */
  outcome: 'proposed' | 'bootstrapped' | null;
  /** Render this once in the screen: the submit modal while it is open. */
  modal: ReactNode;
  /**
   * Run an approvable write. Applied directly (a draft) → done. 409
   * approval_required → the submit modal opens and re-sends the same write
   * with the maker's `approval` (202 → a proposal). `always` opens the modal
   * without trying first (writes that are always proposals: go live, delete).
   */
  run<T>(target: ApprovalTarget, write: Write<T>, options?: { always?: boolean; onApplied?: (data: T) => void }): void;
  clear(): void;
}

/** The approval-required interceptor every object screen reuses (PM/research/11 §4.1). */
export function useApprovalRequest(): ApprovalRequestState {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<'proposed' | 'bootstrapped' | null>(null);
  const [open, setOpen] = useState<{ target: ApprovalTarget; write: Write<unknown> } | null>(null);

  const run = useCallback(<T,>(target: ApprovalTarget, write: Write<T>, options: { always?: boolean; onApplied?: (data: T) => void } = {}) => {
    setError(null);
    setNotice(null);
    setOutcome(null);
    if (options.always) {
      setOpen({ target, write: write as Write<unknown> });
      return;
    }
    start(async () => {
      const r = await write();
      if (r.ok) options.onApplied?.(r.data);
      else if (r.code === 'approval_required') setOpen({ target, write: write as Write<unknown> });
      else setError(r.message);
    });
  }, []);

  const modal = open ? (
    <SubmitForApprovalModal
      target={open.target}
      onClose={() => setOpen(null)}
      submit={async (choice) => {
        const r = await open.write(choice);
        if (!r.ok) return { ok: false, message: r.message };
        setNotice('checkerId' in choice ? 'Sent for approval. The checker has been notified; nothing changes until they approve.' : 'Approved as the only eligible checker (bootstrap) and applied.');
        setOutcome('checkerId' in choice ? 'proposed' : 'bootstrapped');
        return { ok: true };
      }}
    />
  ) : null;

  return { pending, error, notice, outcome, modal, run, clear: () => (setError(null), setNotice(null), setOutcome(null)) };
}
