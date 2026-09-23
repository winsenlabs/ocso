'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { createRouterAction } from '@/lib/actions/routers';

interface Option {
  value: string;
  label: string;
}

/**
 * New router → POST /v1/routers: a DRAFT that starts as pass-through to its
 * fallback queue; the builder adds steps and rules. Routes nothing until a
 * version is approved.
 */
export function NewRouterButton({ queues }: { queues: Option[] }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [fallback, setFallback] = useState(queues[0]?.value ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const router = useRouter();

  async function create() {
    setPending(true);
    setError(null);
    const r = await createRouterAction({ name, description, fallbackQueueId: fallback });
    setPending(false);
    if (!r.ok) return setError(r.message);
    router.push(`/routers/${r.data.id}`);
  }

  return (
    <>
      <button type="button" className="btn accent" onClick={() => setOpen(true)}>
        New router
      </button>
      {open
        ? createPortal(
            <Modal
              title="New router"
              sub="a draft · routes nothing until a version is approved"
              onClose={() => !pending && setOpen(false)}
              maxWidth={520}
              footer={
                <>
                  <span className="sp" />
                  <button type="button" className="btn" onClick={() => setOpen(false)} disabled={pending}>
                    Cancel
                  </button>
                  <button type="button" className="btn accent" disabled={pending || !name.trim() || !fallback} onClick={() => void create()}>
                    {pending ? 'Creating…' : 'Create router'}
                  </button>
                </>
              }
            >
              <div style={{ display: 'grid', gap: 12 }}>
                {error ? (
                  <AlertBanner tone="error" style={{ margin: 0 }}>
                    {error}
                  </AlertBanner>
                ) : null}
                <div className="fld">
                  <label htmlFor="nr-name">Name</label>
                  <input id="nr-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Web chat language menu" />
                </div>
                <div className="fld">
                  <label htmlFor="nr-desc">Description</label>
                  <input id="nr-desc" value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} placeholder="optional" />
                </div>
                <div className="fld">
                  <label htmlFor="nr-fallback">Fallback queue</label>
                  {queues.length ? (
                    <select id="nr-fallback" value={fallback} onChange={(e) => setFallback(e.target.value)}>
                      {queues.map((q) => (
                        <option key={q.value} value={q.value}>
                          {q.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="warn-text">Create a queue first (Queues): every router needs one to fall back to.</span>
                  )}
                  <span className="hint">where customers go when no rule matches; you add steps and rules next</span>
                </div>
              </div>
            </Modal>,
            document.body,
          )
        : null}
    </>
  );
}
