'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRealtime } from '@/lib/realtime/use-realtime';
import '@/app/styles/approvals.css';

interface Notice {
  id: string;
  reportId: string;
  text: string;
}

/**
 * In-app notice when a weekly (or ad-hoc) exception report is frozen and waits
 * for a signature (PM/research/11 §7), wherever the reader is in OCSO. The
 * realtime gate delivers `exception_report.ready` to exceptions.read holders only.
 */
export function ExceptionReportNotice() {
  const [notices, setNotices] = useState<Notice[]>([]);
  useRealtime({
    types: ['exception_report.ready'],
    onEvent: (event) => {
      if (event.type !== 'exception_report.ready') return;
      const p = event.payload;
      const text = `The ${p.kind === 'WEEKLY' ? 'weekly' : 'ad-hoc'} exception report for ${p.periodStart.slice(0, 10)} – ${p.periodEnd.slice(0, 10)} is ready to review.`;
      setNotices((current) => [...current.filter((n) => n.reportId !== p.reportId).slice(-1), { id: event.id, reportId: p.reportId, text }]);
    },
  });
  if (!notices.length) return null;
  return (
    <div className="ap-notices" role="status" aria-live="polite" aria-label="Exception report updates" style={{ bottom: 88 }}>
      {notices.map((n) => (
        <div key={n.id} className="alert warn">
          <span>
            {n.text} <Link href={`/exceptions/reports/${n.reportId}`}>Open</Link>
          </span>
          <button type="button" className="btn tiny ghost" aria-label="Dismiss" onClick={() => setNotices((current) => current.filter((x) => x.id !== n.id))}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
