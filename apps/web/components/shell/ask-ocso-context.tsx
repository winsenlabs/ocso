'use client';

import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AskOcsoCopy } from './ask-ocso-copy';
import { AskOcsoDrawer } from './ask-ocso-drawer';

export const ASK_OCSO_DRAWER_ID = 'ask-ocso-drawer';

interface AskOcsoState {
  open: boolean;
  toggle: () => void;
  close: () => void;
}

const AskOcsoContext = createContext<AskOcsoState | null>(null);

/** Open/closed state of the Ask OCSO drawer; ⌘J / Ctrl+J toggles it anywhere in the app. */
export function AskOcsoProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const value = useMemo(() => ({ open, toggle, close }), [open, toggle, close]);
  return <AskOcsoContext value={value}>{children}</AskOcsoContext>;
}

export function useAskOcso(): AskOcsoState {
  const state = use(AskOcsoContext);
  if (!state) throw new Error('useAskOcso must be used inside AskOcsoProvider');
  return state;
}

/** Renders the drawer when open, with copy resolved from the session on the server. */
export function AskOcsoDrawerHost({ copy }: { copy: AskOcsoCopy }) {
  const { open, close } = useAskOcso();
  return open ? <AskOcsoDrawer id={ASK_OCSO_DRAWER_ID} copy={copy} onClose={close} /> : null;
}
