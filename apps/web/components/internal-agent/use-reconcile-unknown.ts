'use client';

import { useEffect, useRef } from 'react';
import { checkAskOcsoAction } from '../../lib/actions/internal-agent';
import type { ActionDecision } from './decisions';

/** How often, and for how long, a card whose outcome is unknown is re-read (past the API's 5 min confirm grace). */
export const UNKNOWN_POLL_MS = 5_000;
export const UNKNOWN_POLL_FOR_MS = 7 * 60_000;

/**
 * While `active` (the card's outcome is UNKNOWN), re-read the card every few seconds and hand the settled card to
 * `onDecided` once OCSO knows how the confirm ended.
 */
export function useReconcileUnknown(cardId: string, active: boolean, onDecided: (d: ActionDecision) => void): void {
  const onDecidedRef = useRef(onDecided);
  useEffect(() => {
    onDecidedRef.current = onDecided;
  });
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const until = Date.now() + UNKNOWN_POLL_FOR_MS;
    const tick = async () => {
      if (stopped) return;
      const settled = await checkAskOcsoAction(cardId).catch(() => null);
      if (stopped) return;
      if (settled) return onDecidedRef.current(settled);
      if (Date.now() < until) timer = setTimeout(() => void tick(), UNKNOWN_POLL_MS);
    };
    let timer = setTimeout(() => void tick(), UNKNOWN_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active, cardId]);
}
