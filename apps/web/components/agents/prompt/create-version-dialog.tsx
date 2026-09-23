'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { activateVersionAction, createVersionAction } from '@/lib/actions/agents';
import { agentHref } from '../lib/tabs';
import { useApprovalRequest } from '@/components/approvals/use-approval-request';
import { useAgentAction } from '../shared/use-action';

export interface StagedCorrection {
  id: string;
  title: string;
  componentLabel: string;
}

interface Props {
  agentId: string;
  nextVersion: number;
  changed: string[];
  liveVersionId: string | null;
  corrections: StagedCorrection[];
  canActivate: boolean;
  onClose: () => void;
}

/**
 * Snapshot the saved draft as an immutable version (docs/05 §2) with a reason.
 * Staged corrections included here become APPLIED (docs/09 §7). Activation
 * is a separate, explicit step.
 */
export function CreateVersionDialog({ agentId, nextVersion, changed, liveVersionId, corrections, canActivate, onClose }: Props) {
  const action = useAgentAction();
  const [reason, setReason] = useState('');
  const [picked, setPicked] = useState<string[]>(corrections.map((c) => c.id));
  const [created, setCreated] = useState<{ id: string; version: number } | null>(null);
  const [activated, setActivated] = useState(false);
  // Once the agent is live configuration, activating is a prompt_version proposal (PM/research/11 §4).
  const approval = useApprovalRequest();
  const live = activated || approval.outcome === 'bootstrapped';
  const close = () => !action.pending && !approval.pending && onClose();

  if (created) {
    return (
      <Modal
        title={`v${created.version} created`}
        sub="immutable · attributable"
        onClose={close}
        maxWidth={500}
        footer={
          <>
            <Link className="btn ghost" href={agentHref(agentId, { tab: 'versions', ...(liveVersionId ? { from: liveVersionId, to: created.id } : {}) })}>
              View diff
            </Link>
            <span className="sp" />
            <button type="button" className="btn" onClick={close} disabled={action.pending}>
              {live ? 'Close' : 'Later'}
            </button>
            {canActivate && !live ? (
              <button
                type="button"
                className="btn accent"
                disabled={approval.pending || Boolean(approval.notice)}
                onClick={() =>
                  approval.run({ objectKind: 'prompt_version', objectId: created.id, title: `Activate prompt v${created.version}` }, (choice) => activateVersionAction(agentId, created.id, choice), {
                    onApplied: (proposed) => setActivated(proposed === null),
                  })
                }
              >
                {approval.pending ? 'Activating…' : `Activate v${created.version} now`}
              </button>
            ) : null}
          </>
        }
      >
        {action.error || approval.error ? <AlertBanner tone="error" style={{ margin: 0 }}>{action.error ?? approval.error}</AlertBanner> : null}
        {approval.notice ? <AlertBanner style={{ margin: 0 }}>{approval.notice}</AlertBanner> : null}
        {approval.modal}
        <AlertBanner tone={live ? 'info' : 'warn'} title={live ? `v${created.version} is live` : 'Not live yet'} style={{ margin: 0 }}>
          {live
            ? 'New conversations and turns use it now. You can roll back from Versions at any time.'
            : 'The live version is unchanged until someone with activation rights activates this one.'}
        </AlertBanner>
      </Modal>
    );
  }

  return (
    <Modal
      title={`Create version v${nextVersion}`}
      sub={`${changed.length} component${changed.length === 1 ? '' : 's'} changed`}
      onClose={close}
      maxWidth={560}
      footer={
        <>
          <span className="mono-sm">snapshots the saved draft</span>
          <span className="sp" />
          <button type="button" className="btn" onClick={close} disabled={action.pending}>
            Cancel
          </button>
          <button
            type="button"
            className="btn accent"
            disabled={action.pending || reason.trim().length < 3}
            onClick={() => action.run(() => createVersionAction(agentId, reason, picked), (data) => setCreated(data))}
          >
            {action.pending ? 'Creating…' : `Create v${nextVersion}`}
          </button>
        </>
      }
    >
      <div className="agent-form">
        {action.error ? <AlertBanner tone="error" style={{ margin: 0 }}>{action.error}</AlertBanner> : null}
        <p className="mono-sm" style={{ margin: 0 }}>
          changes: {changed.join(', ') || 'none'}
        </p>
        <div className="fld">
          <label htmlFor="cv-reason">Reason for this change</label>
          <textarea id="cv-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} placeholder="Duplicate-debit path shortened" data-autofocus />
          <span className="hint">shown in the version history and the audit log · 3–500 characters</span>
        </div>
        {corrections.length ? (
          <fieldset className="fld" style={{ border: 'none', padding: 0, margin: 0 }}>
            <legend style={{ fontSize: 12, color: 'var(--ink-2)', fontWeight: 500, marginBottom: 5 }}>Staged corrections in this version</legend>
            <div style={{ display: 'grid', gap: 6 }}>
              {corrections.map((c) => (
                <label key={c.id} className="toggle-row">
                  <input type="checkbox" checked={picked.includes(c.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c.id] : p.filter((x) => x !== c.id)))} />
                  <span>
                    {c.title} <span className="mono-sm">· {c.componentLabel}</span>
                  </span>
                </label>
              ))}
            </div>
            <span className="hint">checked corrections are marked applied by this version</span>
          </fieldset>
        ) : null}
      </div>
    </Modal>
  );
}
