'use client';

import Link from 'next/link';
import { AlertBanner } from '@/components/ui/alert-banner';

/**
 * Shared error content for error boundaries. Production builds redact server
 * error messages, so the copy explains the likely cause and offers a retry.
 */
export function ErrorPanel({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <AlertBanner tone="error" title="This page could not load" style={{ margin: 0 }}>
        OCSO could not reach its API or the request failed. If this keeps happening, check that the API service is running and
        reachable from the web service (API_URL).
      </AlertBanner>
      {error.digest ? <span className="mono-sm">reference {error.digest}</span> : null}
      <div className="rowsplit">
        <button type="button" className="btn accent" onClick={reset}>
          Try again
        </button>
        <Link className="btn ghost" href="/">
          Go home
        </Link>
      </div>
    </div>
  );
}
