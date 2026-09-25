'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { connectTemplateAction } from '@/lib/actions/mcp';
import { connectionsHref } from '../url';

/** Creates the user's own copy of a published template, runs discovery, then opens it to authenticate. */
export function ConnectTemplateButton({ templateId, name }: { templateId: string; name: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn tiny accent"
        disabled={pending}
        aria-label={`Connect my account to ${name}`}
        onClick={() =>
          start(async () => {
            const r = await connectTemplateAction(templateId);
            if (!r.ok) setError(r.message);
            else router.replace(connectionsHref({ tab: 'mcp', view: 'mine', connection: r.data.connectionId }), { scroll: false });
          })
        }
      >
        {pending ? 'Connecting…' : 'Connect my account'}
      </button>
      {error ? (
        <span className="err-text" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}
