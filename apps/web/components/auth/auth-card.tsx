import type { ReactNode } from 'react';
import { BrandMark } from '@/components/ui/brand-mark';

/** Compact centred card for sign-in and first-run setup (.auth-wrap/.auth-card). */
export function AuthCard({ title, sub, wide, children, foot }: { title: string; sub?: ReactNode; wide?: boolean; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className={wide ? 'auth-card wide' : 'auth-card'}>
      <div className="auth-brand">
        <BrandMark size={30} />
        <span className="a-word">OCSO</span>
      </div>
      <h1>{title}</h1>
      {sub ? <p className="auth-sub">{sub}</p> : null}
      {children}
      {foot ? <div className="auth-foot">{foot}</div> : null}
    </div>
  );
}

/** Static placeholder while the auth card's data streams in. */
export function AuthCardSkeleton() {
  return (
    <div className="auth-card" aria-busy="true" aria-label="Loading">
      <div className="auth-brand">
        <BrandMark size={30} />
        <span className="a-word">OCSO</span>
      </div>
      <div className="shell-skeleton" style={{ width: '40%', margin: '0 0 18px' }} />
      <div className="shell-skeleton" style={{ margin: '0 0 12px' }} />
      <div className="shell-skeleton" style={{ margin: 0 }} />
    </div>
  );
}
