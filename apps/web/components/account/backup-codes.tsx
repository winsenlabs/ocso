'use client';

import { useState } from 'react';

/** One-time display of backup codes, with copy. */
export function BackupCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <ul className="backup-codes" aria-label="Backup codes">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <button
        type="button"
        className="btn tiny"
        style={{ justifySelf: 'start' }}
        onClick={() => {
          void navigator.clipboard?.writeText(codes.join('\n')).then(() => setCopied(true));
        }}
      >
        {copied ? 'Copied' : 'Copy codes'}
      </button>
    </div>
  );
}
