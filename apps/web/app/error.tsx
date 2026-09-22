'use client';

import { ErrorPanel } from '@/components/shell/error-panel';

/** Root error boundary: API unreachable or an unexpected failure outside the app shell. */
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="auth-wrap">
      <div className="auth-card wide">
        <ErrorPanel error={error} reset={reset} />
      </div>
    </main>
  );
}
