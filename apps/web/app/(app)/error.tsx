'use client';

import { ErrorPanel } from '@/components/shell/error-panel';

/** Page-level error boundary inside the app shell (sidebar stays usable). */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorPanel error={error} reset={reset} />;
}
