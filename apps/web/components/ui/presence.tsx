import type { ReactNode } from 'react';

/** Canonical 8-state presence enum from ocso.css (.presence). */
export type PresenceState = 'working' | 'waiting' | 'blocked' | 'onboarding' | 'idle' | 'off_shift' | 'paused' | 'error';

export function Presence({ state, children }: { state: PresenceState; children: ReactNode }) {
  return (
    <span className={`presence ${state}`}>
      <span className="dot" aria-hidden="true" />
      {children}
    </span>
  );
}
