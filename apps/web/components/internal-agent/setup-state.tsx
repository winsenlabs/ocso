'use client';

import Link from 'next/link';
import { useId, useState, useTransition } from 'react';
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
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (profiles.length === 0) {
    return (
      <span className="ia-setup-row">
        No model profiles exist yet.{' '}
        <Link href="/connections?tab=providers">Create one under Models →</Link>
      </span>
    );
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await chooseAskOcsoProfile(choice);
      if (result.ok) onConfigured();
      else setError(result.message);
    });
  }

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
      ) : (
        <span className="mono-sm">Recorded in the audit log. Ask OCSO answers with each user&apos;s own permissions.</span>
      )}
    </span>
  );
}
