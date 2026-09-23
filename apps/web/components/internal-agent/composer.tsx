'use client';

import { useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react';

/**
 * Ask box + suggestions (design/05 `.dfoot`). Enter sends, Shift+Enter adds a
 * line; while an answer streams, Send becomes Stop (aborts the request).
 */
export function Composer({
  id,
  inputRef,
  roleChip,
  suggestions,
  disabled,
  working,
  attachContext,
  contextLabel,
  onToggleContext,
  onSend,
  onStop,
}: {
  id: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  roleChip: string;
  suggestions: string[];
  /** Not configured / signed out: nothing can be sent. */
  disabled: boolean;
  working: boolean;
  attachContext: boolean;
  contextLabel: string;
  onToggleContext: () => void;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [draft, setDraft] = useState('');
  const blocked = disabled || working;

  function send(text: string) {
    const question = text.trim();
    if (!question || blocked) return;
    onSend(question);
    setDraft('');
    inputRef.current?.focus();
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (working) onStop();
    else send(draft);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send(draft);
    }
  }

  return (
    <>
      <form className="ask-box" onSubmit={onSubmit}>
        <label className="sr-only" htmlFor={`${id}-input`}>
          Ask about this deployment
        </label>
        <textarea
          id={`${id}-input`}
          ref={inputRef}
          data-autofocus
          rows={2}
          value={draft}
          maxLength={4000}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          placeholder="Ask about this deployment — answers come from live data, scoped to your role"
        />
        <div className="rowsplit">
          <span className="mono-sm">{roleChip}</span>
          <span className="sp" />
          <button
            type="button"
            className={attachContext ? 'btn tiny ghost ia-context on' : 'btn tiny ghost ia-context'}
            aria-pressed={attachContext}
            onClick={onToggleContext}
            title={attachContext ? `Sending the open page (${contextLabel}) with each question` : 'The open page is not sent'}
          >
            Attach context
          </button>
          {working ? (
            <button type="submit" className="btn tiny">
              Stop
            </button>
          ) : (
            <button type="submit" className="btn tiny accent" disabled={disabled || !draft.trim()}>
              Send
            </button>
          )}
        </div>
      </form>
      {disabled ? null : (
        <div className="sugg" role="group" aria-label="Suggested questions">
          {suggestions.map((s) => (
            <button key={s} type="button" onClick={() => send(s)} aria-disabled={working || undefined}>
              {s}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
