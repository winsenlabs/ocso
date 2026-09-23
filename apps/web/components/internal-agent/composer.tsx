'use client';

import { useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import type { Suggestion } from './types';

/** Chips stay one or two short rows under the ask box. */
const MAX_CHIPS = 5;

/** Always offered: answered from the capability catalog for this user's role (`onWhatCanYouDo`), else asked of the model. */
export const WHAT_CAN_YOU_DO: Suggestion = { label: 'What can you do?', prompt: 'What can you do?' };

/**
 * Ask box + suggestions (design/05 `.dfoot`). The chips are "What can you
 * do?" plus tasks this user's permissions cover (from the catalog). Enter sends, Shift+Enter adds a
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
  onWhatCanYouDo,
  prefill,
}: {
  id: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  roleChip: string;
  suggestions: Suggestion[];
  /** Not configured / signed out: nothing can be sent. */
  disabled: boolean;
  working: boolean;
  attachContext: boolean;
  contextLabel: string;
  onToggleContext: () => void;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Show the catalog answer instead of asking the model; absent when the API sent no areas. */
  onWhatCanYouDo?: (() => void) | undefined;
  /** A question handed over from the page (e.g. a Home "needs you" item): fills the box once per id. */
  prefill?: { id: number; text: string } | null | undefined;
}) {
  const [draft, setDraft] = useState('');
  const [prefilled, setPrefilled] = useState<number | null>(null);
  const blocked = disabled || working;
  // Adjust state while rendering (not in an effect) when a new question is handed over.
  if (prefill && prefill.id !== prefilled) {
    setPrefilled(prefill.id);
    setDraft(prefill.text);
  }

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
        <div className="sugg ia-sugg" role="group" aria-label="Suggested questions">
          {[WHAT_CAN_YOU_DO, ...suggestions.filter((s) => s.label !== WHAT_CAN_YOU_DO.label)].slice(0, MAX_CHIPS).map((s) => (
            <button key={s.label} type="button" onClick={() => (s === WHAT_CAN_YOU_DO && onWhatCanYouDo && !blocked ? onWhatCanYouDo() : send(s.prompt))} aria-disabled={working || undefined} title={s.prompt === s.label ? undefined : s.prompt}>
              {s.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
