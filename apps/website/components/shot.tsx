import Image from 'next/image';
import type { ReactNode } from 'react';
import { SHOTS, type ShotId } from '@/lib/shots';

/**
 * A real product screenshot (apps/website/public/shots, captured from a local OCSO stack running the Meridian Bank
 * demo seed) in a quiet window frame. When a capture is missing, a restrained panel says what would be shown
 * instead of inventing UI.
 */
export function Shot({ id, caption, priority = false, className }: { id: ShotId; caption?: ReactNode; priority?: boolean; className?: string }) {
  const shot = SHOTS[id];
  return (
    <figure className={`shot ${className ?? ''}`}>
      <div className="shot-frame">
        <div className="shot-bar" aria-hidden="true">
          <span />
          <span />
          <span />
          <em>{shot.path}</em>
        </div>
        {shot.src ? (
          <Image
            src={shot.src}
            alt={shot.alt}
            width={shot.width}
            height={shot.height}
            priority={priority}
            loading={priority ? 'eager' : 'lazy'}
            sizes="(min-width: 1200px) 1100px, 100vw"
            decoding="async"
          />
        ) : (
          <div className="shot-missing" role="img" aria-label={shot.alt}>
            <span>{shot.alt}</span>
          </div>
        )}
      </div>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}
