'use client';

import { useState, useTransition } from 'react';
import { copilotDraftAction, copilotOutcomeAction } from '@/lib/actions/conversations';
import type { CopilotState, CopilotSuggestion } from '@/lib/api/conversations';

export interface CopilotBlockProps {
  conversationId: string;
  agentName: string;
  initial: CopilotState;
  onInsert: (text: string) => void;
}

/**
 * Copilot suggested reply (design/01 .copilot, docs/09 §4 "optional AI
 * copilot assistance"). Drafts are never sent by OCSO: Insert only fills the
 * composer. When the copilot routes are unavailable (not shipped, not
 * permitted, disabled for the agent) the block renders nothing.
 */
export function CopilotBlock({ conversationId, agentName, initial, onInsert }: CopilotBlockProps) {
  const [hidden, setHidden] = useState(initial.status === 'unavailable');
  const [suggestion, setSuggestion] = useState<CopilotSuggestion | null>(initial.status === 'ready' ? initial.suggestion : null);
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // A newer server suggestion (realtime copilot.suggestion → refresh) replaces the shown one.
  const [seen, setSeen] = useState<string | null>(initial.status === 'ready' ? initial.suggestion.id : null);
  if (initial.status === 'ready' && initial.suggestion.id !== seen) {
    setSeen(initial.suggestion.id);
    setSuggestion(initial.suggestion);
  }

  if (hidden) return null;

  const draft = (style: 'default' | 'shorter', baseText?: string) =>
    start(async () => {
      setError(null);
      const res = await copilotDraftAction(conversationId, style, baseText);
      if (res.ok) setSuggestion(res.suggestion);
      else if (res.hidden) setHidden(true);
      else setError(res.message);
    });

  const outcome = (s: CopilotSuggestion, value: 'INSERTED' | 'DISMISSED') => void copilotOutcomeAction(s.id, value);

  const shown = suggestion && suggestion.id !== dismissedId ? suggestion : null;
  if (!shown) {
    return (
      <div className="copilot" aria-label="Copilot">
        <div className="ch2">
          <span>{agentName} · copilot</span>
          <span className="sp" style={{ flex: 1 }} />
          <button type="button" className="btn tiny ghost" disabled={pending} onClick={() => draft('default')}>
            {pending ? 'Drafting…' : 'Suggest a reply'}
          </button>
        </div>
        {error ? (
          <span role="alert" className="mono-sm" style={{ color: 'var(--danger)' }}>
            {error}
          </span>
        ) : null}
      </div>
    );
  }

  const basis = [
    shown.basis.historyMessages > 0 ? 'based on this conversation' : null,
    shown.basis.policyRefs.length ? `policy ${shown.basis.policyRefs.join(', ')}` : null,
    shown.style && shown.style !== 'default' ? shown.style : null,
  ].filter(Boolean);

  return (
    <div className="copilot" aria-label="Copilot suggestion">
      <div className="ch2">
        <span>{shown.agentName} · suggested reply</span>
        {basis.length ? (
          <span className="mono-sm" style={{ textTransform: 'none', letterSpacing: 0 }}>
            {basis.join(' · ')}
          </span>
        ) : null}
        <span className="sp" style={{ flex: 1 }} />
        <span className="schip accent">draft</span>
      </div>
      <div className="cb">“{shown.text}”</div>
      <div className="rowsplit">
        <button
          type="button"
          className="btn tiny"
          disabled={pending}
          onClick={() => {
            onInsert(shown.text);
            outcome(shown, 'INSERTED');
            setDismissedId(shown.id);
          }}
        >
          Insert
        </button>
        <button type="button" className="btn tiny ghost" disabled={pending} onClick={() => draft('shorter', shown.text)}>
          {pending ? 'Rewriting…' : 'Rewrite shorter'}
        </button>
        <button
          type="button"
          className="btn tiny ghost"
          disabled={pending}
          onClick={() => {
            outcome(shown, 'DISMISSED');
            setDismissedId(shown.id);
          }}
        >
          Dismiss
        </button>
        <span className="sp" />
        <span className="mono-sm">not sent until you send it</span>
      </div>
      {error ? (
        <span role="alert" className="mono-sm" style={{ color: 'var(--danger)' }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
