'use client';

import { useState } from 'react';
import { FILM } from '@/content/links';

/**
 * The 60-second film. Until someone presses play this is only our own poster, so it makes no third-party
 * requests; pressing play loads YouTube's privacy-enhanced player.
 */
export function Film({ className = '' }: { className?: string }) {
  const [playing, setPlaying] = useState(false);
  return (
    <figure className={`mx-auto w-full max-w-4xl ${className}`}>
      <div className="relative aspect-video overflow-hidden rounded-2xl border border-white/15 bg-[#070a10] shadow-[0_40px_120px_-30px_rgba(61,93,207,0.75)] md:rounded-3xl">
        {playing ? (
          <iframe
            src={`${FILM.embed}?autoplay=1&rel=0&modestbranding=1&playsinline=1`}
            title={FILM.title}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            className="absolute inset-0 size-full"
          />
        ) : (
          <button type="button" onClick={() => setPlaying(true)} aria-label={`Play the film: ${FILM.title}`} className="group absolute inset-0 size-full cursor-pointer">
            {/* eslint-disable-next-line @next/next/no-img-element -- a pre-sized poster, served as is */}
            <img src={FILM.poster} alt="Still from the film: channels, AI models, agent tools, alerts, email and infrastructure plugged into the OCSO core" width={1600} height={900} loading="lazy" decoding="async" className="absolute inset-0 size-full object-cover opacity-90 transition group-hover:opacity-100" />
            <span className="absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-transparent" />
            <span className="absolute left-1/2 top-1/2 grid size-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white shadow-[0_0_60px_rgba(61,93,207,0.9)] transition group-hover:scale-110 md:size-20">
              <svg viewBox="0 0 24 24" className="ml-1 size-7 fill-[#11171d] md:size-8" aria-hidden>
                <path d="M7 4.5v15l13-7.5z" />
              </svg>
            </span>
            <span className="absolute bottom-3 left-3 rounded-full border border-white/20 bg-black/55 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-white backdrop-blur md:bottom-5 md:left-5 md:text-xs">
              Watch · 60 seconds
            </span>
          </button>
        )}
      </div>
    </figure>
  );
}
