import { Suspense, type ReactNode } from 'react';

/**
 * The session- and data-dependent part of a page. Pages render their static
 * head (top bar, title) immediately and stream this body, so navigations are
 * instant under cacheComponents.
 */
export function PageBody({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) {
  return <Suspense fallback={fallback ?? <BodySkeleton />}>{children}</Suspense>;
}

export function BodySkeleton() {
  return (
    <div aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div className="tiles" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(146px,1fr))' }}>
        {[0, 1, 2, 3].map((i) => (
          <div className="tile" key={i} style={{ height: 70 }} />
        ))}
      </div>
      <div className="shell-skeleton" style={{ width: '60%', margin: '0 0 12px' }} />
      <div className="shell-skeleton" style={{ width: '45%', margin: 0 }} />
    </div>
  );
}
