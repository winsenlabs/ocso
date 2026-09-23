'use client';

import '@/app/styles/internal-agent.css';
import { useChat } from '@ai-sdk/react';
import { usePathname } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { classifyChatError, type ChatProblem } from '@/components/internal-agent/chat-errors';
import { Composer } from '@/components/internal-agent/composer';
import { contextObjectLabel, pageContext } from '@/components/internal-agent/page-context';
import { ProblemNotice } from '@/components/internal-agent/problem-notice';
import { SetupState } from '@/components/internal-agent/setup-state';
import { ThreadList } from '@/components/internal-agent/thread-list';
import { AssistantTurn, OcsoAvatar, UserTurn } from '@/components/internal-agent/turns';
import type { AskOcsoSession } from '@/components/internal-agent/use-ask-ocso-session';
import { AgentPortrait } from '@/components/ui/brand-mark';
import { Drawer } from '@/components/ui/drawer';
import { areaLabel } from '@/lib/nav-active';
import type { AskOcsoCopy } from './ask-ocso-copy';

/**
 * Ask OCSO drawer (design/05, docs/12). Questions stream through
 * /api/internal-agent/chat to the internal agent, which acts with exactly
 * this user's permissions: answers carry step lines, object links, tables,
 * role refusals and confirmation cards for writes. Threads persist per user.
 */
export function AskOcsoDrawer({ id, copy, session, onClose }: { id: string; copy: AskOcsoCopy; session: AskOcsoSession; onClose: () => void }) {
  const pathname = usePathname();
  const { messages, status, error, stop } = useChat({ chat: session.chat });
  const [showHistory, setShowHistory] = useState(false);
  const [attachContext, setAttachContext] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const { refresh } = session;

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const working = status === 'submitted' || status === 'streaming';
  const problem = error ? classifyChatError(error) : null;
  const load = session.load;
  const loadProblem = load.status === 'error' ? loadFailure(load.httpStatus) : null;
  const notConfigured = (load.status === 'ready' && !load.data.configured) || problem?.kind === 'not_configured';
  const blocked = notConfigured || problem?.kind === 'signed_out' || loadProblem?.kind === 'signed_out' || loadProblem?.kind === 'forbidden';
  const context = pageContext(pathname);
  const objectLabel = contextObjectLabel(context);
  const contextLabel = `${areaLabel(pathname)}${objectLabel ? ` · ${objectLabel}` : ''}`;
  const last = messages.at(-1);

  useEffect(() => {
    if (problem?.kind === 'not_configured') void refresh();
  }, [problem?.kind, refresh]);

  // Follow the answer while it streams, unless the user scrolled up to read.
  useLayoutEffect(() => {
    const scroller = endRef.current?.closest('.dbody');
    if (!scroller) return;
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160) endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, status]);

  async function openThread(threadId: string) {
    if (await session.openThread(threadId)) {
      setShowHistory(false);
      inputRef.current?.focus();
    }
  }

  function newThread() {
    session.newThread();
    setShowHistory(false);
    inputRef.current?.focus();
  }

  const actions = (
    <>
      <button type="button" className="icon-btn" aria-label="Conversation history" aria-pressed={showHistory} title="Earlier conversations" onClick={() => setShowHistory((v) => !v)}>
        ☰
      </button>
      <button type="button" className="icon-btn" aria-label="New conversation" title="New conversation" onClick={newThread} disabled={working}>
        ＋
      </button>
    </>
  );

  const footer = (
    <Composer
      id={id}
      inputRef={inputRef}
      roleChip={copy.roleChip}
      suggestions={copy.suggestions}
      disabled={blocked}
      working={working}
      attachContext={attachContext}
      contextLabel={contextLabel}
      onToggleContext={() => setAttachContext((v) => !v)}
      onSend={(text) => session.send(text, attachContext ? context : null)}
      onStop={() => void stop()}
    />
  );

  return (
    <Drawer id={id} title="Ask OCSO" sub={copy.scopeLine} icon={<AgentPortrait background="var(--accent)" />} onClose={onClose} footer={footer} actions={actions}>
      <div className="rowsplit">
        <span className="grp">context · {attachContext ? contextLabel : 'not attached'}</span>
        <span className="sp" />
        <span className="mono-sm">{copy.roleChip}</span>
      </div>
      {showHistory ? (
        <ThreadList threads={load.status === 'ready' ? load.data.threads : null} activeId={session.threadId} busy={working} onOpen={(t) => void openThread(t)} onNew={newThread} />
      ) : null}
      {notConfigured ? (
        <SetupState
          canConfigure={copy.canConfigure}
          profiles={load.status === 'ready' ? load.data.profiles : null}
          onConfigured={() => {
            session.chat.clearError();
            void refresh();
          }}
        />
      ) : null}
      {messages.length === 0 && !notConfigured ? (
        <div className="aturn">
          <OcsoAvatar />
          <span className="bd">
            <span className="ans ia-intro">
              Ask about conversations, agents, queues or configuration. OCSO answers from live data with exactly your permissions, and changes only
              happen after you confirm them.
            </span>
          </span>
        </div>
      ) : null}
      <div className="ia-log" role="log" aria-label="Ask OCSO conversation" aria-live="off">
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <UserTurn key={m.id} message={m} initials={copy.userInitials} />
          ) : (
            <AssistantTurn
              key={m.id}
              message={m}
              streaming={working && i === messages.length - 1}
              durationMs={session.durations.get(m.id) ?? null}
              stopped={session.stopped.has(m.id)}
              decisions={session.decisions}
              onDecided={session.decide}
              userName={copy.userName}
            />
          ),
        )}
        {working && last?.role !== 'assistant' ? (
          <AssistantTurn message={null} streaming durationMs={null} stopped={false} decisions={session.decisions} onDecided={session.decide} userName={copy.userName} />
        ) : null}
        {problem && problem.kind !== 'not_configured' && !working ? (
          <ProblemNotice problem={problem} onRetry={session.retry} />
        ) : loadProblem ? (
          <ProblemNotice problem={loadProblem} onRetry={() => void refresh()} />
        ) : null}
        <div ref={endRef} />
      </div>
      <span className="sr-only" role="status">
        {working ? 'Ask OCSO is answering…' : last?.role === 'assistant' ? 'Answer ready.' : ''}
      </span>
    </Drawer>
  );
}

/** The drawer could not load its state (GET /api/internal-agent). */
function loadFailure(httpStatus: number | null): ChatProblem {
  if (httpStatus === 401) return { kind: 'signed_out' };
  if (httpStatus === 403) return { kind: 'forbidden', message: 'Your role cannot use Ask OCSO.' };
  if (httpStatus === null || httpStatus === 503 || httpStatus === 504) return { kind: 'offline' };
  return { kind: 'failed', message: 'Ask OCSO could not load your conversations.' };
}
