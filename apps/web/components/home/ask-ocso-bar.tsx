'use client';

import { useState, type FormEvent } from 'react';
import { AgentPortrait } from '@/components/ui/brand-mark';
import { ASK_OCSO_DRAWER_ID, useAskOcso } from '@/components/shell/ask-ocso-context';

export interface AskChip {
  label: string;
  prompt: string;
}

/**
 * Ask OCSO on Home (HOME decision 2): a question box under the greeting and
 * the role's suggestion chips. Submitting opens the drawer and asks at once;
 * the answer streams there, scoped to this user's permissions.
 */
export function AskOcsoBar({ chips }: { chips: AskChip[] }) {
  const { ask, open } = useAskOcso();
  const [text, setText] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    ask(text, { send: true });
    setText('');
  }

  return (
    <section className="home-ask" aria-label="Ask OCSO">
      <form className="home-ask-box" onSubmit={submit} role="search" aria-label="Ask OCSO a question">
        <span className="home-ask-mark" aria-hidden="true">
          <AgentPortrait background="var(--accent)" />
        </span>
        <label className="sr-only" htmlFor="home-ask-input">
          Ask OCSO
        </label>
        <input
          id="home-ask-input"
          type="text"
          value={text}
          maxLength={4000}
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask OCSO about your work — answers come from live data, scoped to your role"
        />
        <button type="submit" className="btn tiny accent" disabled={!text.trim()} aria-controls={open ? ASK_OCSO_DRAWER_ID : undefined}>
          Ask
        </button>
      </form>
      {chips.length ? (
        <div className="home-ask-chips" role="group" aria-label="Suggested questions">
          {chips.slice(0, 4).map((c) => (
            <button key={c.label} type="button" onClick={() => ask(c.prompt, { send: true })} title={c.prompt === c.label ? undefined : c.prompt}>
              {c.label}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** "Ask OCSO" on one "needs you" item: opens the drawer with the item's ready question in the ask box. */
export function AskAboutButton({ question, subject }: { question: string; subject: string }) {
  const { ask } = useAskOcso();
  return (
    <button type="button" className="btn tiny ghost home-ask-about" onClick={() => ask(question)} aria-label={`Ask OCSO about ${subject}`} title={question}>
      Ask OCSO
    </button>
  );
}
