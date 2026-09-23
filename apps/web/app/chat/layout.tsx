import type { ReactNode } from 'react';
import '../styles/webchat.css';

/** Customer web chat surface: public, no staff shell (docs/07 §4 — separate from the CS workspace). */
export default function ChatLayout({ children }: { children: ReactNode }) {
  return children;
}
