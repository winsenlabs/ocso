'use client';

import Link from 'next/link';
import { useState, useTransition, type ReactNode } from 'react';
import { StatusChip, type StatusTone } from '@/components/ui/status-chip';
import { testProviderAction } from '@/lib/actions/models';
import type { ProviderTestResult } from '@/lib/api/models';
import { formatLatency } from '@/lib/format';

const RESULT: Record<ProviderTestResult['status'], { tone: StatusTone; label: string }> = {
  OK: { tone: 'good', label: 'test passed' },
  DEGRADED: { tone: 'warn', label: 'degraded' },
  DOWN: { tone: 'danger', label: 'test failed' },
  UNCONFIGURED: { tone: 'warn', label: 'not testable' },
};

/** Value-free explanation of a test result (the API never includes credentials or raw bodies). */
function detailOf(r: ProviderTestResult): string {
  const model = r.model ? `${r.model} · ` : '';
  if (r.call?.ok) {
    const latency = r.call.latencyMs !== null ? formatLatency(r.call.latencyMs) : '—';
    return `${model}${latency}${r.call.replyPreview ? ` · replied “${r.call.replyPreview}”` : ''}`;
  }
  if (r.call?.error) return `${model}${r.call.error.code}: ${r.call.error.message}`;
  if (r.status === 'OK') return `${model}health probe ok${r.health.latencyMs !== null ? ` · ${formatLatency(r.health.latencyMs)}` : ''}`;
  if (r.status === 'UNCONFIGURED' && !r.model && r.health.detail?.startsWith('No model')) {
    return 'No model to probe: set a health model in the provider settings or create a profile that uses it.';
  }
  return `${model}${r.health.detail ?? r.status.toLowerCase()}`;
}

/** Card footer: Test connection (POST /v1/model-providers/:id/test), Edit, policy chips, and the last test result. */
export function ProviderCardFooter({ providerId, canManage, editHref, chips, lifecycle }: { providerId: string; canManage: boolean; editHref: string; chips: ReactNode; lifecycle?: ReactNode }) {
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function test() {
    setError(null);
    start(async () => {
      const r = await testProviderAction(providerId, null);
      if (r.ok) setResult(r.data);
      else {
        setResult(null);
        setError(r.message);
      }
    });
  }

  const shown = result ? RESULT[result.status] : null;
  return (
    <>
      <div className="rowsplit">
        {canManage ? (
          <>
            <button type="button" className="btn tiny" onClick={test} disabled={pending}>
              {pending ? 'Testing…' : 'Test'}
            </button>
            <Link className="btn tiny ghost" href={editHref} scroll={false}>
              Edit
            </Link>
            {lifecycle}
          </>
        ) : null}
        <span className="sp" />
        {chips}
      </div>
      <div role="status" aria-live="polite" className="pvd-test">
        {error ? <span className="err-text">Test could not run: {error}</span> : null}
        {result && shown ? (
          <>
            <StatusChip tone={shown.tone}>{shown.label}</StatusChip>
            <span className="mono-sm">{detailOf(result)}</span>
          </>
        ) : null}
      </div>
    </>
  );
}
