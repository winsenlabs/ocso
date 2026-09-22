'use client';

import { useState } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';

/** A set-password link to hand over out of band (only returned when email is not configured). */
export function InviteLink({ link, note, expiresAt }: { link: string; note: string; expiresAt?: string | undefined }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="invite-link">
      <AlertBanner tone="warn" style={{ margin: 0 }}>
        {note}
      </AlertBanner>
      <label className="mono-sm" htmlFor="invite-link">
        Set-password link{expiresAt ? ` · expires ${new Date(expiresAt).toLocaleString()}` : ''}
      </label>
      <input id="invite-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
      <button
        type="button"
        className="btn tiny"
        style={{ justifySelf: 'start' }}
        onClick={() => void navigator.clipboard?.writeText(link).then(() => setCopied(true))}
      >
        {copied ? 'Copied' : 'Copy link'}
      </button>
    </div>
  );
}
