/* eslint-disable @next/next/no-img-element -- pre-sized WebP, served as is. */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Shot } from '@/content/shots';

const num = (i: number) => String(i + 1).padStart(2, '0');

function Caption({ shots, i, large = false }: { shots: Shot[]; i: number; large?: boolean }) {
  const s = shots[i]!;
  return (
    <div>
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-accent">
        {num(i)} · {s.caption}
      </p>
      <p className={`mt-2 font-medium text-fg ${large ? 'text-2xl' : 'text-lg'}`}>{s.title}</p>
      <p className="mt-2 text-[15px] leading-relaxed text-fg/65">{s.body}</p>
      {s.catches && (
        <p className="mt-4 border-t border-fg/10 pt-4 text-sm text-fg/60">
          <span className="font-medium text-fg/80">Catches:</span> {s.catches}
        </p>
      )}
    </div>
  );
}

/** The real product screens: a card each, and a larger view with next and previous. */
export function ShotGallery({ shots }: { shots: Shot[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(null);
    opener.current?.focus();
  }, []);
  const step = useCallback((d: number) => setOpen((o) => (o === null ? o : (o + d + shots.length) % shots.length)), [shots.length]);

  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    closeBtn.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close, step]);

  const current = open === null ? null : shots[open]!;
  return (
    <>
      <div className="no-scrollbar -mx-6 flex snap-x snap-mandatory gap-5 overflow-x-auto px-6 pb-4 md:mx-0 md:grid md:grid-cols-3 md:gap-x-5 md:gap-y-10 md:overflow-visible md:px-0 md:pb-0">
        {shots.map((s, i) => (
          <article key={s.src} className="group/card flex w-[85%] shrink-0 snap-center flex-col gap-3 md:w-auto">
            <button
              type="button"
              onClick={(e) => {
                opener.current = e.currentTarget;
                setOpen(i);
              }}
              aria-label={`Open the ${s.caption.toLowerCase()} screen`}
              className="group relative block aspect-[16/10] overflow-hidden rounded-xl border border-fg/12 bg-surface transition hover:border-accent/60 focus-visible:border-accent"
            >
              <img src={s.src} alt={s.alt} width={s.width} height={s.height} loading="lazy" decoding="async" className="block h-full w-full object-cover object-left-top transition duration-500 group-hover:scale-[1.02]" />
              <span className="absolute bottom-3 right-3 rounded-full border border-fg/15 bg-bg/85 px-3 py-1 text-xs text-fg/80 opacity-0 backdrop-blur transition group-hover:opacity-100 group-focus-visible:opacity-100">
                Expand ↗
              </span>
            </button>
            <div className="flex-1 rounded-xl border border-fg/10 bg-fg/[0.02] px-6 py-7 transition group-hover/card:border-fg/20">
              <Caption shots={shots} i={i} />
            </div>
          </article>
        ))}
      </div>

      {open !== null &&
        current &&
        createPortal(
          <div className="fixed inset-0 z-[100] bg-black/85 backdrop-blur-md" onClick={close}>
            <div
              role="dialog"
              aria-modal="true"
              aria-label={current.caption}
              onClick={(e) => e.stopPropagation()}
              className="flex h-full flex-col gap-3 overflow-y-auto p-3 lg:flex-row lg:items-stretch lg:overflow-hidden"
            >
              <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
                <img src={current.src} alt={current.alt} width={current.width} height={current.height} className="block h-auto max-h-full w-auto max-w-full rounded-2xl border border-white/10 shadow-[0_40px_120px_-30px_rgba(61,93,207,0.5)]" />
              </div>
              <aside className="flex shrink-0 flex-col rounded-2xl border border-fg/10 bg-surface p-7 lg:w-72">
                <div className="flex items-center justify-between text-sm text-fg/55">
                  <span className="font-mono">
                    {num(open)} / {num(shots.length - 1)}
                  </span>
                  <button ref={closeBtn} type="button" onClick={close} className="rounded-full px-3 py-1.5 hover:bg-fg/10 hover:text-fg">
                    Close <span className="font-mono text-fg/35">Esc</span>
                  </button>
                </div>
                <div className="mt-8 flex-1">
                  <Caption shots={shots} i={open} large />
                </div>
                <div className="mt-8 flex gap-2">
                  <button type="button" onClick={() => step(-1)} className="flex-1 whitespace-nowrap rounded-full border border-fg/20 px-3 py-2.5 text-sm text-fg hover:bg-fg/10">
                    ← Prev
                  </button>
                  <button type="button" onClick={() => step(1)} className="flex-1 whitespace-nowrap rounded-full bg-fg px-3 py-2.5 text-sm font-medium text-bg hover:bg-fg/90">
                    Next →
                  </button>
                </div>
                <p className="mt-6 text-xs text-fg/45">Meridian Bank is the fictional bank in OCSO’s demo seed.</p>
              </aside>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
