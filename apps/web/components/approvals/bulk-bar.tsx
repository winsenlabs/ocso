'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { bulkApproveAction } from '@/lib/actions/approvals';
import { bulkLabel } from './lib/selection';

/**
 * Sticky bulk bar: "Approve 3 selected · 2 excluded", one reason, one submit.
 * The API decides each item in its own transaction with its own decision row;
 * anything that changed meanwhile is skipped and reported.
 */
export function BulkBar({
  items,
  excludedCount,
  firstExcludedHref,
  onDone,
}: {
  items: Array<{ id: string; contentHash: string }>;
  excludedCount: number;
  firstExcludedHref: string | null;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [pending, start] = useTransition();

  function approve() {
    setMessage(null);
    start(async () => {
      const r = await bulkApproveAction({ reason, items });
      if (!r.ok) return setMessage({ tone: 'error', text: r.message });
      const skipped = r.data.skipped.length;
      setMessage({ tone: skipped ? 'error' : 'info', text: `${r.data.approved} approved${skipped ? `, ${skipped} need you to open them` : ''}.` });
      setReason('');
      onDone();
    });
  }

  return (
    <div className="ap-bulk" role="region" aria-label="Bulk approve">
      <b style={{ fontSize: 12.5 }}>{bulkLabel(items.length, excludedCount)}</b>
      {excludedCount && firstExcludedHref ? (
        <Link className="mono-sm" href={firstExcludedHref} scroll={false}>
          open the first excluded
        </Link>
      ) : null}
      <input type="text" aria-label="Reason for the approvals" placeholder="Reason (recorded on each decision)" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      <button type="button" className="btn accent" disabled={pending || !items.length || reason.trim().length < 3} onClick={approve}>
        {pending ? 'Approving…' : `Approve ${items.length}`}
      </button>
      {message ? (
        <AlertBanner tone={message.tone} style={{ margin: 0, flexBasis: '100%' }}>
          {message.text}
        </AlertBanner>
      ) : null}
    </div>
  );
}
