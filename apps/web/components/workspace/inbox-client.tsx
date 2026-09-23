'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import type { Inbox, InboxView, Option } from '@/lib/api/conversations';
import { EPHEMERAL_TYPES, REALTIME_EVENT_TYPES } from '@/lib/realtime/events';
import { useRealtime } from '@/lib/realtime/use-realtime';
import { InboxRow } from './inbox-row';
import { channelMark, type KindMarks } from './lib/channel';
import { InboxTagFilter } from './inbox-tag-filter';
import { tagParam } from './lib/tags';
import { WORKSPACE_CHANGED } from './lib/use-action';
import { useNow } from './lib/use-now';

const VIEWS: ReadonlyArray<{ key: InboxView; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'mine', label: 'Assigned to me' },
  { key: 'waiting', label: 'Waiting for human' },
  { key: 'ai', label: 'AI active' },
  { key: 'human', label: 'Human active' },
  { key: 'priority', label: 'Priority' },
  { key: 'resolved', label: 'Resolved' },
  // A router is still deciding which queue (PM/research/11 §5.7).
  { key: 'routing', label: 'Routing' },
];
const VIEW_KEYS = new Set<string>(VIEWS.map((v) => v.key));

/** Conversation-level events that can change a row; deltas and alerts never do. */
const INBOX_EVENTS = REALTIME_EVENT_TYPES.filter((t) => !EPHEMERAL_TYPES.has(t) && !t.startsWith('alert.') && t !== 'config.changed' && t !== 'copilot.suggestion');

export interface InboxClientProps {
  defaultView: InboxView;
  agents: Option[];
  queues: Option[];
  meId: string;
  timeZone: string;
  /** Each channel kind's mark, from its descriptor (GET /v1/channels/kinds). */
  marks: KindMarks;
}

/** Inbox pane (design/01 left): views with live counts, search, agent/queue filters, live rows. */
export function InboxClient({ defaultView, agents, queues, meId, timeZone, marks }: InboxClientProps) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const selectedId = pathname.startsWith('/conversations/') ? pathname.split('/')[2] : undefined;
  const initialView = searchParams.get('view');
  const [view, setView] = useState<InboxView>(initialView && VIEW_KEYS.has(initialView) ? (initialView as InboxView) : defaultView);
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [agentId, setAgentId] = useState('');
  const [queueId, setQueueId] = useState('');
  // `?tag=` (analytics, rail chips) sets the filter; links without it leave the chosen filter alone.
  const urlTag = tagParam(searchParams.get('tag'));
  const [tag, setTag] = useState<string | null>(urlTag);
  useEffect(() => {
    if (urlTag) setTag(urlTag);
  }, [urlTag]);
  const [data, setData] = useState<Inbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(1_000);
  const inflight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    const params = new URLSearchParams({ view });
    if (term) params.set('search', term);
    if (agentId) params.set('agentId', agentId);
    if (queueId) params.set('queueId', queueId);
    if (tag) params.set('tag', tag);
    try {
      const res = await fetch(`/api/conversations?${params.toString()}`, { cache: 'no-store', signal: ctrl.signal });
      const body = (await res.json()) as Inbox | { error?: { message?: string } };
      if (!res.ok || !('items' in body)) {
        setError(('error' in body && body.error?.message) || 'Could not load conversations.');
        return;
      }
      setData(body);
      setError(null);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError('Could not reach OCSO. Retrying when the connection returns.');
    }
  }, [view, term, agentId, queueId, tag]);

  useEffect(() => {
    void load();
  }, [load]);

  // Debounce typing into the search box.
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A reload scheduled before the view or filters changed must run the current query, not the one it closed over
  // (it would abort the newer request and show the old view's rows under the new view's counts).
  const latestLoad = useRef(load);
  latestLoad.current = load;
  const scheduleLoad = useCallback(() => {
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      void latestLoad.current();
    }, 400);
  }, []);
  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current);
    },
    [],
  );
  // Actions taken in the conversation pane change rows (claim, resolve…): re-query at once.
  useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener(WORKSPACE_CHANGED, onChanged);
    return () => window.removeEventListener(WORKSPACE_CHANGED, onChanged);
  }, [load]);

  const live = useRealtime({ types: INBOX_EVENTS, onEvent: scheduleLoad, onReconnect: scheduleLoad });

  const replaceParams = (edit: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams.toString());
    edit(params);
    const qs = params.toString();
    window.history.replaceState(null, '', qs ? `${pathname}?${qs}` : pathname);
  };

  const chooseView = (next: InboxView) => {
    setView(next);
    replaceParams((params) => (next === defaultView ? params.delete('view') : params.set('view', next)));
  };

  const chooseTag = (next: string | null) => {
    setTag(next);
    replaceParams((params) => (next ? params.set('tag', next) : params.delete('tag')));
  };

  const hrefFor = (id: string) => {
    const params = new URLSearchParams();
    if (view !== defaultView) params.set('view', view);
    if (tag) params.set('tag', tag);
    const qs = params.toString();
    return `/conversations/${id}${qs ? `?${qs}` : ''}`;
  };
  const counts = data?.counts;
  const items = data?.items ?? [];
  const viewLabel = VIEWS.find((v) => v.key === view)?.label ?? view;

  return (
    <section className="inbox" aria-label="Inbox">
      <div className="ih page-head">
        <div className="rowsplit">
          <h1>Conversations</h1>
          {counts ? (
            <span className="count-badge" style={{ margin: 0 }} title="Open conversations you can see">
              {counts.all.toLocaleString('en')}
            </span>
          ) : null}
          <span className="sp" />
          <span className="mono-sm" title="Live updates" aria-live="polite">
            {live === 'open' ? 'live' : live === 'retrying' ? 'reconnecting…' : live === 'closed' ? 'offline' : ''}
          </span>
        </div>
        <label className="ws-search">
          <span className="sr-only">Search conversations</span>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search customer, number, or conversation id" />
        </label>
      </div>
      <div className="filters" role="group" aria-label="Views">
        {VIEWS.map((v) => (
          <button key={v.key} type="button" className={v.key === view ? 'fchip active' : 'fchip'} aria-pressed={v.key === view} onClick={() => chooseView(v.key)}>
            {v.label}
            {counts ? <span className="fchip-count">{counts[v.key].toLocaleString('en')}</span> : null}
          </button>
        ))}
        {agents.length > 1 ? (
          <select aria-label="Agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        ) : null}
        {queues.length > 1 ? (
          <select aria-label="Queue" value={queueId} onChange={(e) => setQueueId(e.target.value)}>
            <option value="">All queues</option>
            {queues.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </select>
        ) : null}
        <InboxTagFilter tag={tag} onChange={chooseTag} />
      </div>
      <div className="list" aria-busy={data === null && !error ? true : undefined}>
        {error ? (
          <div className="alert error" role="alert" style={{ margin: 12 }}>
            <span>{error}</span>
          </div>
        ) : null}
        {data === null && !error ? <InboxSkeletonRows /> : null}
        {data !== null && items.length === 0 ? (
          <div style={{ padding: 12 }}>
            <InboxEmpty view={view} term={term} tag={tag} waiting={counts?.waiting ?? 0} onShowWaiting={() => chooseView('waiting')} onClearTag={() => chooseTag(null)} />
          </div>
        ) : null}
        {items.map((item) => (
          <InboxRow key={item.id} item={item} href={hrefFor(item.id)} selected={item.id === selectedId} meId={meId} timeZone={timeZone} now={now} activeTag={tag} mark={channelMark(marks, item.channel.kind)} />
        ))}
        {items.length > 0 && counts ? (
          <div className="stream-foot">
            {items.length} of {counts[view].toLocaleString('en')} · {viewLabel.toLowerCase()}
            {tag ? ` · tagged ${tag}` : ''}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function InboxEmpty({ view, term, tag, waiting, onShowWaiting, onClearTag }: { view: InboxView; term: string; tag: string | null; waiting: number; onShowWaiting: () => void; onClearTag: () => void }) {
  if (tag && !term) {
    return (
      <EmptyState
        size="sm"
        title={`No conversations tagged “${tag}” here`}
        actions={
          <button type="button" className="btn tiny" onClick={onClearTag}>
            Clear tag filter
          </button>
        }
      >
        Try another view, or clear the tag filter.
      </EmptyState>
    );
  }
  if (term) return <EmptyState size="sm" title={`No conversations match “${term}”`}>Search looks at customer names, identities, message previews and conversation ids.</EmptyState>;
  if (view === 'mine') {
    return (
      <EmptyState
        size="sm"
        title="Nothing assigned to you"
        actions={
          waiting > 0 ? (
            <button type="button" className="btn tiny accent" onClick={onShowWaiting}>
              Show waiting for human ({waiting})
            </button>
          ) : undefined
        }
      >
        Conversations you claim, accept or take over appear here.
      </EmptyState>
    );
  }
  if (view === 'routing') return <EmptyState size="sm" title="No router is asking anyone">Conversations whose router is still choosing a queue (a menu or a classifier) appear here.</EmptyState>;
  if (view === 'waiting') return <EmptyState size="sm" title="Nobody is waiting for a human">Escalated conversations in your queues appear here to claim.</EmptyState>;
  return <EmptyState size="sm" title="No conversations here">Nothing in this view right now. New conversations appear live.</EmptyState>;
}

export function InboxSkeletonRows() {
  return (
    <>
      <span className="sr-only">Loading conversations…</span>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="ws-skel" aria-hidden="true" />
      ))}
    </>
  );
}
