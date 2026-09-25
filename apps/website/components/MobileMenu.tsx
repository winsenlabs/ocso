'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { REPO_URL, SECTIONS } from '@/content/links';
import { ThemedMark } from './Mark';

/** The nav on small screens: a menu button and a full-screen panel. */
export function MobileMenu() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const close = () => setOpen(false);
  const item = 'border-b border-fg/10 py-4 text-2xl font-medium text-fg';
  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="mobile-menu"
        aria-label="Open menu"
        onClick={() => setOpen(true)}
        className="grid size-9 shrink-0 place-items-center rounded-full border border-fg/15 text-fg"
      >
        <svg viewBox="0 0 20 20" className="size-5" aria-hidden>
          <path d="M3.5 6.5h13M3.5 13.5h13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div id="mobile-menu" role="dialog" aria-modal="true" aria-label="Menu" className="fixed inset-0 z-[100] flex flex-col overflow-y-auto bg-bg px-5 pb-10 pt-5 text-left md:hidden">
            <div className="flex items-center justify-between">
              <a href="#top" onClick={close} className="flex items-center gap-2 font-semibold text-fg">
                <ThemedMark className="size-8" />
                OCSO
              </a>
              <button type="button" onClick={close} aria-label="Close menu" className="grid size-10 place-items-center rounded-full border border-fg/15 text-fg">
                <svg viewBox="0 0 20 20" className="size-5" aria-hidden>
                  <path d="M5 5l10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <nav aria-label="Mobile" className="mt-8 flex flex-col">
              {SECTIONS.map((s) => (
                <a key={s.id} href={`#${s.id}`} onClick={close} className={item}>
                  {s.label}
                </a>
              ))}
              <a href={REPO_URL} onClick={close} className={item}>
                GitHub
              </a>
            </nav>
            <a href="#demo" onClick={close} className="mt-10 rounded-2xl bg-fg px-5 py-4 text-center font-medium text-bg">
              Request a demo
            </a>
          </div>,
          document.body,
        )}
    </div>
  );
}
