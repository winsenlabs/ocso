'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRealtime } from '@/lib/realtime/use-realtime';
import { templateNotice, type TemplateNotice } from './lib/notices';
import '@/app/styles/templates.css';

/**
 * Review results of the templates this person submitted, wherever they are
 * in OCSO (docs/07 §3): WhatsApp decides minutes to hours later, so the
 * result is announced in-app instead of waiting on the templates page.
 */
export function TemplateNotices({ meId }: { meId: string }) {
  const [notices, setNotices] = useState<TemplateNotice[]>([]);
  useRealtime({
    types: ['whatsapp_template.status_changed'],
    onEvent: (event) => {
      if (event.type !== 'whatsapp_template.status_changed') return;
      const notice = templateNotice(event.id, event.payload, meId);
      if (notice) setNotices((current) => [...current.filter((n) => n.id !== notice.id).slice(-2), notice]);
    },
  });
  if (!notices.length) return null;
  return (
    <div className="tpl-notices" role="status" aria-live="polite" aria-label="WhatsApp template updates">
      {notices.map((n) => (
        <div key={n.id} className={`alert ${n.tone === 'good' ? '' : n.tone}`}>
          <span>
            {n.text} <Link href={n.href}>View templates</Link>
          </span>
          <button type="button" className="btn tiny ghost" aria-label="Dismiss" onClick={() => setNotices((current) => current.filter((x) => x.id !== n.id))}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
