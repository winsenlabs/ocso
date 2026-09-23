'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useRealtime } from '@/lib/realtime/use-realtime';
import { decidedNotice, requestedNotice, type ApprovalNotice } from './lib/notices';
import '@/app/styles/approvals.css';

/**
 * In-app approval notices wherever the person is in OCSO: the maker hears the
 * outcome ("Your change was approved"), the checker hears that changes wait
 * for them. Email is sent by the worker as well.
 */
export function ApprovalNotices({ meId }: { meId: string }) {
  const [notices, setNotices] = useState<ApprovalNotice[]>([]);
  const waiting = useRef(new Set<string>());
  const add = (n: ApprovalNotice | null) => {
    if (n) setNotices((current) => [...current.filter((x) => x.id !== n.id).slice(-2), n]);
  };
  useRealtime({
    types: ['approval.requested', 'approval.decided'],
    onEvent: (event) => {
      if (event.type === 'approval.decided') {
        waiting.current.delete(event.payload.proposalId);
        add(decidedNotice(event.id, event.payload, meId));
      } else if (event.type === 'approval.requested' && event.payload.checkerId === meId) {
        waiting.current.add(event.payload.proposalId);
        add(requestedNotice(event.payload, meId, waiting.current.size));
      }
    },
  });
  if (!notices.length) return null;
  return (
    <div className="ap-notices" role="status" aria-live="polite" aria-label="Approval updates">
      {notices.map((n) => (
        <div key={n.id} className={`alert ${n.tone === 'good' ? '' : n.tone}`}>
          <span>
            {n.text} <Link href={n.href}>Open</Link>
          </span>
          <button type="button" className="btn tiny ghost" aria-label="Dismiss" onClick={() => setNotices((current) => current.filter((x) => x.id !== n.id))}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
