'use client';

import { usePathname } from 'next/navigation';
import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { AgentPortrait } from '@/components/ui/brand-mark';
import { Drawer } from '@/components/ui/drawer';
import { areaLabel } from '@/lib/nav-active';
import type { AskOcsoCopy } from './ask-ocso-copy';

type Outcome = 'pending' | 'unavailable' | 'signed_out' | 'failed';

interface Turn {
  id: number;
  question: string;
  outcome: Outcome;
}

const NOTICE: Record<Exclude<Outcome, 'pending'>, { title: string; body: string }> = {
  unavailable: {
    title: 'The internal agent is not available yet.',
    body: 'Your question was not sent to a model. Once the OCSO agent API ships, answers here will be cited and limited to what your role can see.',
  },
  signed_out: { title: 'Your session has ended.', body: 'Sign in again to use Ask OCSO.' },
  failed: { title: 'OCSO could not be reached.', body: 'Check your connection and try again.' },
};

/**
 * Ask OCSO drawer shell (design/05). Questions post to /api/internal-agent,
 * which answers 501 until the internal agent API exists; the drawer says so
 * plainly and never fabricates an answer.
 */
export function AskOcsoDrawer({ id, copy, onClose }: { id: string; copy: AskOcsoCopy; onClose: () => void }) {
  const pathname = usePathname();
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const busy = turns.some((t) => t.outcome === 'pending');

  async function ask(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    const turnId = Date.now();
    setTurns((ts) => [...ts, { id: turnId, question: text, outcome: 'pending' }]);
    setDraft('');
    inputRef.current?.focus();
    const outcome = await post(text, pathname);
    setTurns((ts) => ts.map((t) => (t.id === turnId ? { ...t, outcome } : t)));
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void ask(draft);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void ask(draft);
    }
  }

  const footer = (
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
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about this deployment — answers are cited and scoped to your role"
        />
        <div className="rowsplit">
          <span className="mono-sm">{copy.roleChip}</span>
          <span className="sp" />
          <button type="submit" className="btn tiny accent" disabled={busy || !draft.trim()}>
            Send
          </button>
        </div>
      </form>
      <div className="sugg" role="group" aria-label="Suggested questions">
        {copy.suggestions.map((s) => (
          <button key={s} type="button" onClick={() => void ask(s)} aria-disabled={busy || undefined}>
            {s}
          </button>
        ))}
      </div>
    </>
  );

  return (
    <Drawer id={id} title="Ask OCSO" sub={copy.scopeLine} icon={<AgentPortrait background="var(--accent)" />} onClose={onClose} footer={footer}>
      <div className="rowsplit">
        <span className="grp">context · {areaLabel(pathname)}</span>
        <span className="sp" />
        <span className="mono-sm">{copy.roleChip}</span>
      </div>
      {turns.length === 0 ? (
        <div className="aturn">
          <span className="who" style={{ background: 'var(--accent)', color: '#fff' }} aria-hidden="true">
            OC
          </span>
          <span className="bd">
            <span className="ans" style={{ fontSize: 13, color: 'var(--ink-2)' }}>
              Ask about conversations, agents, alerts or configuration. OCSO acts with exactly your permissions, and sensitive changes always
              need your confirmation.
            </span>
          </span>
        </div>
      ) : null}
      <div style={{ display: 'grid', gap: 16 }} aria-live="polite">
        {turns.map((t) => (
          <TurnView key={t.id} turn={t} initials={copy.userInitials} />
        ))}
      </div>
    </Drawer>
  );
}

function TurnView({ turn, initials }: { turn: Turn; initials: string }) {
  return (
    <>
      <div className="aturn me">
        <span className="who" aria-hidden="true">
          {initials}
        </span>
        <span className="bd">{turn.question}</span>
      </div>
      <div className="aturn">
        <span className="who" style={{ background: 'var(--accent)', color: '#fff' }} aria-hidden="true">
          OC
        </span>
        <span className="bd">
          {turn.outcome === 'pending' ? (
            <span className="mono-sm">checking…</span>
          ) : (
            <span className="denied">
              <b style={{ color: 'var(--ink-2)' }}>{NOTICE[turn.outcome].title}</b> {NOTICE[turn.outcome].body}
            </span>
          )}
        </span>
      </div>
    </>
  );
}

async function post(message: string, context: string): Promise<Exclude<Outcome, 'pending'>> {
  try {
    const res = await fetch('/api/internal-agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, context }),
    });
    if (res.status === 401) return 'signed_out';
    return res.status === 501 ? 'unavailable' : 'failed';
  } catch {
    return 'failed';
  }
}
