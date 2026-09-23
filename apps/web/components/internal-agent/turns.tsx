'use client';

import type { ActionDecision } from '../../lib/actions/internal-agent';
import { ActionCard } from './action-card';
import { AnswerText } from './answer-text';
import { DeniedNotice, LinkCards, MiniTable, StepsLine } from './parts';
import type { AskOcsoMessage, MiniTableData, ObjectLink, PendingAction } from './types';

/** Conversation turns in the Ask OCSO drawer (design/05 `.aturn`). */

export function UserTurn({ message, initials }: { message: AskOcsoMessage; initials: string }) {
  const text = message.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');
  return (
    <div className="aturn me">
      <span className="who" aria-hidden="true">
        {initials}
      </span>
      <span className="bd">
        <span className="sr-only">You: </span>
        {text}
      </span>
    </div>
  );
}

export function OcsoAvatar() {
  return (
    <span className="who ia-who" aria-hidden="true">
      OC
    </span>
  );
}

interface Grouped {
  steps: string[];
  text: string;
  tables: MiniTableData[];
  links: ObjectLink[];
  actions: PendingAction[];
  denied: string[];
}

export function groupParts(message: AskOcsoMessage): Grouped {
  const g: Grouped = { steps: [], text: '', tables: [], links: [], actions: [], denied: [] };
  for (const p of message.parts) {
    if (p.type === 'text') g.text += p.text;
    else if (p.type === 'data-step') g.steps.push(p.data.label);
    else if (p.type === 'data-table') g.tables.push(p.data);
    else if (p.type === 'data-links') g.links.push(...p.data);
    else if (p.type === 'data-action') g.actions.push(p.data);
    else if (p.type === 'data-denied') g.denied.push(p.data.message);
  }
  return g;
}

export interface AssistantTurnProps {
  message: AskOcsoMessage | null;
  streaming: boolean;
  durationMs: number | null;
  stopped: boolean;
  decisions: ReadonlyMap<string, ActionDecision>;
  onDecided: (actionId: string, decision: ActionDecision) => void;
  userName: string;
}

/** One answer: steps, proposed actions, text, tables, object links, then role refusals. */
export function AssistantTurn({ message, streaming, durationMs, stopped, decisions, onDecided, userName }: AssistantTurnProps) {
  const g = message ? groupParts(message) : groupParts({ id: 'pending', role: 'assistant', parts: [] });
  const empty = !g.text && !g.tables.length && !g.links.length && !g.actions.length && !g.denied.length;
  return (
    <div className="aturn" aria-busy={streaming || undefined}>
      <OcsoAvatar />
      <span className="bd">
        <span className="sr-only">Ask OCSO: </span>
        <StepsLine steps={g.steps} durationMs={durationMs} working={streaming && !g.text} />
        {g.actions.map((a) => (
          <ActionCard key={a.id} action={a} decision={decisions.get(a.id)} onDecided={(d) => onDecided(a.id, d)} userName={userName} />
        ))}
        {g.text ? <AnswerText text={g.text} streaming={streaming} /> : null}
        {g.tables.map((t, i) => (
          <MiniTable key={i} table={t} />
        ))}
        <LinkCards links={g.links} />
        {g.denied.map((d, i) => (
          <DeniedNotice key={i} message={d} />
        ))}
        {stopped ? <span className="ia-muted">Stopped. {empty ? 'No answer was given.' : 'The answer above is incomplete.'}</span> : null}
        {!streaming && !stopped && empty ? <span className="ia-muted">No answer was given.</span> : null}
      </span>
    </div>
  );
}
