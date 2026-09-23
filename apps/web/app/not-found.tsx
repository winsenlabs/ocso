import Link from 'next/link';
import { BrandMark } from '@/components/ui/brand-mark';
import { EmptyState } from '@/components/ui/empty-state';

export default function NotFound() {
  return (
    <main className="auth-wrap">
      <div className="auth-card wide">
        <div className="auth-brand">
          <BrandMark />
          <span className="a-word">OCSO</span>
        </div>
        <EmptyState
          title="Page not found"
          actions={
            <Link className="btn accent tiny" href="/">
              Go home
            </Link>
          }
        >
          This address does not exist in this deployment.
        </EmptyState>
      </div>
    </main>
  );
}
