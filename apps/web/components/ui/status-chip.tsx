import type { ReactNode } from 'react';

export type StatusTone = 'good' | 'warn' | 'danger' | 'accent' | 'muted';

/** Generic status chip (.schip): amber warns, red breaks, green confirms, indigo is AI/draft. */
export function StatusChip({ tone = 'muted', children, title }: { tone?: StatusTone; children: ReactNode; title?: string }) {
  return (
    <span className={`schip ${tone}`} title={title}>
      {children}
    </span>
  );
}
