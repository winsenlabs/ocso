import Link from 'next/link';
import type { ReactNode } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';

export interface RailAlert {
  key: string;
  title: string;
  body: ReactNode;
  tone: 'warn' | 'info' | 'error';
  href?: string | undefined;
}

/** Compact alert stack for rail cards ("For you", "Needs a decision"). */
export function AlertList({ items, empty, limit = 4 }: { items: RailAlert[]; empty: string; limit?: number }) {
  if (items.length === 0) return <span className="mono-sm">{empty}</span>;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {items.slice(0, limit).map((a) => (
        <AlertBanner
          key={a.key}
          tone={a.tone}
          title={a.title}
          style={{ margin: 0 }}
          action={
            a.href ? (
              <Link className="mono-sm" href={a.href} aria-label={`Open: ${a.title}`}>
                open →
              </Link>
            ) : undefined
          }
        >
          {a.body}
        </AlertBanner>
      ))}
    </div>
  );
}
