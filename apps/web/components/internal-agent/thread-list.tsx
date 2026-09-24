'use client';

import type { ThreadSummary } from './types';

/** "just now", "12m ago", "3h ago", "2d ago" — then the date. */
export function relativeTime(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'just now';
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

/** The user's earlier Ask OCSO conversations (GET /v1/internal-agent/threads). */
export function ThreadList({
  threads,
  activeId,
  busy,
  onOpen,
  onNew,
}: {
  threads: ThreadSummary[] | null;
  activeId: string | null;
  busy: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const now = Date.now();
  return (
    <section className="ia-history" aria-label="Conversation history">
      <div className="rowsplit">
        <span className="grp">earlier conversations</span>
        <span className="sp" />
        <button type="button" className="btn tiny ghost" onClick={onNew} disabled={busy}>
          New conversation
        </button>
      </div>
      {threads === null ? (
        <span className="ia-muted">Loading…</span>
      ) : threads.length === 0 ? (
        <span className="ia-muted">No earlier conversations yet. Questions you ask are kept here, visible only to you.</span>
      ) : (
        <ul className="ia-threads">
          {threads.map((t) => (
            <li key={t.id}>
              <button type="button" className="ia-thread" aria-current={t.id === activeId ? 'true' : undefined} onClick={() => onOpen(t.id)} disabled={busy}>
                <span className="ia-thread-title">{t.title}</span>
                <span className="mono-sm">
                  {t.surface ? `in ${t.surface.replace(/_/g, ' ')} · ` : ''}
                  {relativeTime(t.updatedAt, now)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
