'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useApprovalRequest } from '@/components/approvals/use-approval-request';
import { SETTINGS_OBJECT_ID } from '@/components/settings/lib/settings-approval';
import { chooseAskOcsoProfile } from '../../lib/actions/internal-agent';
import type { ProfileOption } from './types';

/**
 * Ask OCSO has no model yet (deployment setting `internalAgentProfileId`).
 * A Tech admin can choose a profile right here; everyone else is told who
 * can. Questions are never sent anywhere until it is configured.
 */
export function SetupState({ canConfigure, profiles, onConfigured }: { canConfigure: boolean; profiles: ProfileOption[] | null; onConfigured: () => void }) {
  return (
    <div className="denied ia-setup" role="status">
      <b style={{ color: 'var(--ink-2)' }}>Ask OCSO is not set up yet.</b>{' '}
      {canConfigure
        ? 'It needs a model profile to run on. Choose one below; you can change it later from here or through the deployment settings API.'
        : 'It needs a model profile, which a Tech admin chooses (they are shown the choice when they open Ask OCSO). Until then, nothing you type is sent to a model.'}
      {canConfigure ? <ProfilePicker profiles={profiles ?? []} onConfigured={onConfigured} /> : null}
    </div>
  );
}

function ProfilePicker({ profiles, onConfigured }: { profiles: ProfileOption[]; onConfigured: () => void }) {
  const id = useId();
  const [choice, setChoice] = useState(profiles[0]?.id ?? '');
  const approval = useApprovalRequest();
  const pending = approval.pending;

  if (profiles.length === 0) {
    return (
      <span className="ia-setup-row">
        No model profiles exist yet.{' '}
        <Link href="/connections?tab=providers">Create one under Models →</Link>
      </span>
    );
  }

  // A deployment setting: the change is a proposal a second person approves (the submit modal asks who).
  function save() {
    approval.run({ objectKind: 'deployment_settings', objectId: SETTINGS_OBJECT_ID, title: 'Choose the model profile for Ask OCSO' }, (a) => chooseAskOcsoProfile(choice, a), {
      onApplied: (data) => {
        if (!data.proposed) onConfigured();
      },
    });
  }
  const error = approval.error;

  return (
    <span className="ia-setup-row">
      <label htmlFor={id} className="mono-sm">
        Model profile for Ask OCSO
      </label>
      <span className="rowsplit">
        <select id={id} className="ia-select" value={choice} onChange={(e) => setChoice(e.target.value)} disabled={pending}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {`${p.name} · ${p.model}${p.providerName ? ` · ${p.providerName}` : ''}`}
            </option>
          ))}
        </select>
        <button type="button" className="btn tiny accent" onClick={save} disabled={pending || !choice}>
          {pending ? 'Saving…' : 'Use this profile'}
        </button>
      </span>
      {error ? (
        <span className="ia-error" role="alert">
          {error}
        </span>
      ) : approval.notice ? (
        <span className="mono-sm" role="status">
          {approval.outcome === 'bootstrapped' ? 'Approved and applied. Reopen Ask OCSO to start.' : 'Sent for approval: Ask OCSO starts on this profile once a second person approves it.'}
        </span>
      ) : (
        <span className="mono-sm">A second person approves the choice. Ask OCSO answers with each user&apos;s own permissions.</span>
      )}
      {approval.modal}
    </span>
  );
}
