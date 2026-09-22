import type { ReactNode } from 'react';

/** Keyboard shortcut hint. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
