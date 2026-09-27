'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { demoForm as def } from '@/content/forms';
import { Form, hasSavedDraft } from './DemoFormSteps';

/**
 * Below the lg breakpoint the form is stepped and opens full screen from a button; from lg up it is one landscape
 * page of three columns, in place.
 */
const STEPPED_QUERY = '(max-width: 1023px)';
const subscribeStepped = (cb: () => void) => {
  const mq = window.matchMedia(STEPPED_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};
const useStepped = () => useSyncExternalStore(subscribeStepped, () => window.matchMedia(STEPPED_QUERY).matches, () => false);

const noop = () => () => {};
/** False during server rendering, true in the browser: lets the form read its draft on first render. */
const useMounted = () => useSyncExternalStore(noop, () => true, () => false);

/**
 * On phones and tablets: a button in the page that opens the stepped form full screen, with a close button on top.
 * Every "Request a demo" link on the page opens it too, instead of scrolling to the button.
 */
function DemoSheet() {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [draft, setDraft] = useState(hasSavedDraft);
  const closeButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const show = () => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setDraft(hasSavedDraft());
    requestAnimationFrame(() => returnFocus.current?.focus());
  };

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const link = e.target instanceof Element ? e.target.closest('a[href="#demo"]') : null;
      if (!link || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      show();
    };
    document.addEventListener('click', onClick);
    if (window.location.hash === '#demo') show();
    return () => document.removeEventListener('click', onClick);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    closeButton.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      {sent ? (
        <div role="status" className="flex items-center gap-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent/20 text-accent">✓</span>
          <p className="text-fg/75">{def.successTitle}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <p className="text-fg/65">Three short steps: about you, your company and your customer success.{draft && ' Your answers so far are saved on this device.'}</p>
          <button type="button" onClick={show} aria-haspopup="dialog" className="rounded-2xl bg-fg px-6 py-4 font-medium text-bg transition hover:bg-fg/90">
            {draft ? 'Continue your request' : def.title}
          </button>
        </div>
      )}
      {open &&
        createPortal(
          <div role="dialog" aria-modal="true" aria-label={def.title} className="fixed inset-0 z-[100] flex flex-col overflow-y-auto bg-bg">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-fg/10 bg-bg px-5 py-4">
              <p className="font-medium text-fg">{def.title}</p>
              <button ref={closeButton} type="button" onClick={close} aria-label="Close" className="grid size-10 place-items-center rounded-full border border-fg/15 text-fg">
                <svg viewBox="0 0 20 20" className="size-5" aria-hidden>
                  <path d="M5 5l10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className="mx-auto w-full max-w-xl flex-1 px-5 pb-10 pt-7">
              <Form stepped onDone={() => setSent(true)} />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function Responsive() {
  return useStepped() ? <DemoSheet /> : <Form stepped={false} />;
}

/** The request-a-demo form. Renders in the browser only, so it can pick up an unsent draft. */
export function DemoForm() {
  const mounted = useMounted();
  if (!mounted) return <div className="min-h-[34rem] max-lg:min-h-[8rem]" aria-busy="true" />;
  return <Responsive />;
}
