'use client';

import type { PromptComponent } from '../data/agent-schemas';
import type { ComponentState } from '../lib/prompt-draft';

interface Props {
  index: number;
  component: PromptComponent;
  /** Text shown: the unsaved edit when there is one, else the saved draft. */
  text: string;
  tokens: number | null;
  state: ComponentState;
  editing: boolean;
  canEdit: boolean;
  onEdit: () => void;
  onDone: () => void;
  onRevert: () => void;
  onChange: (text: string) => void;
}

const OWNER: Readonly<Record<string, string>> = { PLATFORM: 'owned by platform · read only', HEAD: 'cs lead' };

/** One versioned prompt component (.pcomp), editable in place by the Lead (docs/archive/specs/05 §1). */
export function ComponentCard({ index, component, text, tokens, state, editing, canEdit, onEdit, onDone, onRevert, onChange }: Props) {
  const platform = component.owner === 'PLATFORM';
  const id = `pc-${component.key}`;
  return (
    <section className={state === 'live' ? 'pcomp' : 'pcomp edited'} aria-label={`Prompt component ${component.label}`} data-component={component.key}>
      <div className="ph2">
        <span className="ix">{index.toString().padStart(2, '0')}</span>
        <span className="nm" id={`${id}-name`}>
          {component.label}
        </span>
        <span className="lock">{OWNER[component.owner] ?? component.owner.toLowerCase()}</span>
        <span className="sp" style={{ flex: 1 }} />
        {state === 'unsaved' ? <span className="schip accent">edited · unsaved</span> : null}
        {state === 'draft' ? <span className="schip accent" title="Saved in the draft; not in the live version yet">draft · not live</span> : null}
        {tokens !== null ? <span className="mono-sm">{tokens.toLocaleString('en')} tokens</span> : null}
        {canEdit && !platform ? (
          <>
            {state === 'unsaved' ? (
              <button type="button" className="btn tiny ghost" onClick={onRevert} aria-label={`Revert ${component.label}`}>
                Revert
              </button>
            ) : null}
            <button type="button" className="btn tiny ghost" onClick={editing ? onDone : onEdit} aria-label={`${editing ? 'Done editing' : 'Edit'} ${component.label}`}>
              {editing ? 'Done' : 'Edit'}
            </button>
          </>
        ) : null}
      </div>
      {platform ? (
        <div className="pb">{component.help}</div>
      ) : editing ? (
        <>
          <div className="help">{component.help}</div>
          <textarea
            id={id}
            aria-labelledby={`${id}-name`}
            value={text}
            maxLength={20_000}
            rows={Math.min(16, Math.max(4, text.split('\n').length + 1))}
            onChange={(e) => onChange(e.target.value)}
            autoFocus
          />
        </>
      ) : text.trim() ? (
        <div className="pb">{text}</div>
      ) : (
        <div className="pb empty-text">Empty — left out of the compiled prompt. {component.help}</div>
      )}
    </section>
  );
}
