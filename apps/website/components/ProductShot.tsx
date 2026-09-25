/* eslint-disable @next/next/no-img-element -- pre-sized WebP, served as is (no image optimizer in the container). */
import type { Shot } from '@/content/shots';

/** A real product screenshot in a quiet browser frame. */
export function ProductShot({ shot, eager = false, className = '' }: { shot: Shot; eager?: boolean; className?: string }) {
  return (
    <figure className={`overflow-hidden rounded-2xl border border-fg/12 bg-surface shadow-[0_30px_80px_-30px_rgba(61,93,207,0.45)] ${className}`}>
      <div className="flex items-center gap-1.5 border-b border-fg/10 px-4 py-2.5" aria-hidden>
        <span className="size-2.5 rounded-full bg-fg/15" />
        <span className="size-2.5 rounded-full bg-fg/15" />
        <span className="size-2.5 rounded-full bg-fg/15" />
        <span className="ml-3 truncate rounded-md bg-fg/[0.06] px-3 py-0.5 font-mono text-[11px] text-fg/45">ocso · {shot.path}</span>
      </div>
      <img src={shot.src} alt={shot.alt} width={shot.width} height={shot.height} loading={eager ? 'eager' : 'lazy'} decoding="async" className="block h-auto w-full" />
    </figure>
  );
}
