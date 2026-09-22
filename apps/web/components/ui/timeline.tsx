import type { ReactNode } from 'react';

export type TimelineKind = 'cust' | 'ai' | 'hum' | 'note';

export interface TimelineEventProps {
  kind: TimelineKind;
  /** Initials in the author square. */
  who: string;
  author: string;
  /** Mono role caption, e.g. "virtual agent · support" or "internal note · not sent to customer". */
  role: string;
  time: string;
  /** ISO timestamp for the <time> element. */
  dateTime?: string;
  children: ReactNode;
}

/**
 * One interaction in the conversation timeline (.ev). Customer turns sit on
 * the left; AI, human and note turns indent. Notes are never customer-visible.
 */
export function TimelineEvent({ kind, who, author, role, time, dateTime, children }: TimelineEventProps) {
  return (
    <div className={`ev ${kind}`}>
      <span className="who" aria-hidden="true">
        {who}
      </span>
      <span className="bd">
        <span className="hd">
          <span className="a">{author}</span>
          <span className="r">{role}</span>
          <time className="t" dateTime={dateTime}>
            {time}
          </time>
        </span>
        <span className="tx">{children}</span>
      </span>
    </div>
  );
}

/** System event (.sysev): one hairline row, no card. `highlight` marks escalations. */
export function SystemEvent({ children, highlight }: { children: ReactNode; highlight?: boolean }) {
  return (
    <div className={highlight ? 'sysev hi' : 'sysev'} role="note">
      <span className="s">{children}</span>
    </div>
  );
}

export interface ToolEventProps {
  /** Tool name, e.g. "cards.list_transactions". */
  name: string;
  /** Mono meta after the name: connection · side effect · latency · outcome. */
  meta: string;
  status: 'ok' | 'warn' | 'fail';
  /** Result facts shown as `key value` pairs. */
  facts?: Array<{ k: string; v: ReactNode }>;
}

const DOT: Record<ToolEventProps['status'], string> = { ok: 'okdot', warn: 'okdot w', fail: 'okdot d' };

/** Tool call result (.toolev): operational facts, never chain-of-thought. */
export function ToolEvent({ name, meta, status, facts = [] }: ToolEventProps) {
  return (
    <div className="toolev">
      <span />
      <span className="bd">
        <span className="th">
          <span className={DOT[status]} aria-hidden="true" />
          <span className="nmx">{name}</span>
          <span>· {meta}</span>
        </span>
        {facts.length ? (
          <span className="kvs">
            {facts.map((f) => (
              <span key={f.k}>
                {f.k} <b>{f.v}</b>
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </div>
  );
}
