'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { deleteTemplateAction } from '@/lib/actions/templates';
import { useRealtime } from '@/lib/realtime/use-realtime';

/** Delete at the provider, after an explicit confirm (providers may block the name for a while, WhatsApp for 30 days). */
export function DeleteTemplateButton({ channelId, templateId, name }: { channelId: string; templateId: string; name: string }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!confirming) {
    return (
      <button type="button" className="btn tiny ghost" onClick={() => setConfirming(true)} aria-label={`Delete ${name}`}>
        Delete
      </button>
    );
  }
  return (
    <span className="rowsplit" role="group" aria-label={`Confirm deleting ${name}`}>
      <span className="mono-sm">{error ?? 'delete at the provider? the name is blocked for 30 days'}</span>
      <button
        type="button"
        className="btn tiny danger"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await deleteTemplateAction(channelId, templateId);
            if (!result.ok) setError(result.message);
          })
        }
      >
        {pending ? 'Deleting…' : 'Delete'}
      </button>
      <button type="button" className="btn tiny ghost" disabled={pending} onClick={() => setConfirming(false)}>
        Keep
      </button>
    </span>
  );
}

/** Review results arrive live: the list refreshes on a status change or another template change. */
export function TemplatesLive({ channelId }: { channelId: string }) {
  const router = useRouter();
  useRealtime({
    types: ['message_template.status_changed', 'config.changed'],
    onEvent: (event) => {
      if (event.type === 'message_template.status_changed' ? event.payload.channelId === channelId : event.type === 'config.changed' && event.payload.area === 'message_templates') router.refresh();
    },
    onReconnect: () => router.refresh(),
  });
  return null;
}
