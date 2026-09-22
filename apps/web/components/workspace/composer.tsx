'use client';

import { useRef, useState } from 'react';
import { addNoteAction, sendReplyAction } from '@/lib/actions/conversations';
import type { CopilotState, WorkspaceTool } from '@/lib/api/conversations';
import { CopilotBlock } from './copilot-block';
import { ToolAction } from './tool-action';
import { useActionRunner } from './lib/use-action';

export type ComposerMode = 'reply' | 'note' | 'tool';

export interface ComposerProps {
  conversationId: string;
  /** How to address the customer: first name, or "the customer" when unknown. */
  customerName: string;
  channelLabel: string;
  agentName: string;
  copilot: CopilotState;
  tools: WorkspaceTool[];
  can: { reply: boolean; note: boolean; runTools: boolean };
}

function newClientMessageId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Composer (design/01 .comp): reply to the customer, internal note (never
 * sent to the customer), or a tool action. Shown only while this human holds
 * the conversation; otherwise the locked bar explains why.
 */
export function Composer({ conversationId, customerName, channelLabel, agentName, copilot, tools, can }: ComposerProps) {
  const [mode, setMode] = useState<ComposerMode>(can.reply ? 'reply' : 'note');
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const [passToAgent, setPassToAgent] = useState(false);
  const clientId = useRef(newClientMessageId());
  const { pending, error, clearError, run } = useActionRunner();
  const [sentFlash, setSentFlash] = useState<string | null>(null);

  const isNote = mode === 'note';
  const text = isNote ? note : reply;
  const setText = isNote ? setNote : setReply;

  const submit = () => {
    if (!text.trim() || pending) return;
    if (isNote) {
      void run(() => addNoteAction(conversationId, note, passToAgent)).then((ok) => {
        if (ok) {
          setNote('');
          setPassToAgent(false);
          setSentFlash('Note added · visible to CS staff only');
        }
      });
    } else {
      void run(() => sendReplyAction(conversationId, reply, clientId.current)).then((ok) => {
        if (ok) {
          setReply('');
          clientId.current = newClientMessageId();
          setSentFlash(`Sent to ${customerName}`);
        }
      });
    }
  };

  const modes: Array<{ key: ComposerMode; label: string; allowed: boolean }> = [
    { key: 'reply', label: 'Reply to customer', allowed: can.reply },
    { key: 'note', label: 'Internal note', allowed: can.note },
    { key: 'tool', label: 'Tool action', allowed: true },
  ];

  return (
    <div className={isNote ? 'comp noteon' : 'comp'}>
      <div className="modes" role="tablist" aria-label="Composer mode">
        {modes
          .filter((m) => m.allowed)
          .map((m) => (
            <button
              key={m.key}
              type="button"
              role="tab"
              aria-selected={mode === m.key}
              className={mode === m.key ? 'fchip active' : 'fchip'}
              onClick={() => {
                setMode(m.key);
                clearError();
                setSentFlash(null);
              }}
            >
              {m.label}
            </button>
          ))}
        <span className="sp" style={{ flex: 1 }} />
        <span className="mono-sm">{channelLabel.toLowerCase()} · text replies</span>
      </div>

      {mode === 'reply' ? <CopilotBlock conversationId={conversationId} agentName={agentName} initial={copilot} onInsert={(t) => setReply((cur) => (cur.trim() ? `${cur.trim()}\n\n${t}` : t))} /> : null}

      {mode === 'tool' ? (
        <ToolAction conversationId={conversationId} tools={tools} canRun={can.runTools} />
      ) : (
        <form
          className="box"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="sr-only" htmlFor="ws-composer">
            {isNote ? 'Internal note' : `Reply to ${customerName}`}
          </label>
          <textarea
            id="ws-composer"
            rows={2}
            value={text}
            placeholder={isNote ? 'Internal note — never sent to the customer' : `Reply to ${customerName} on ${channelLabel}`}
            onChange={(e) => {
              setText(e.target.value);
              setSentFlash(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            maxLength={isNote ? 8000 : 32000}
          />
          <div className="brow">
            {isNote ? (
              <label className="pass">
                <input type="checkbox" checked={passToAgent} onChange={(e) => setPassToAgent(e.target.checked)} />
                pass to {agentName} on return
              </label>
            ) : null}
            <span className="mono-sm">{isNote ? 'visible to CS Lead and CS Exec only' : 'shift + enter for a new line'}</span>
            <span className="sp" style={{ flex: 1 }} />
            {error ? (
              <span className="err" role="alert">
                {error}
              </span>
            ) : sentFlash ? (
              <span className="mono-sm" role="status">
                {sentFlash}
              </span>
            ) : null}
            <button type="submit" className={isNote ? 'btn tiny primary' : 'btn tiny accent'} disabled={pending || !text.trim()}>
              {pending ? 'Sending…' : isNote ? 'Add note' : 'Send reply'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export interface LockedBarProps {
  text: string;
  action: { label: string; onClick: () => void; disabled?: boolean } | null;
}

/** Composer replacement when this human cannot write (design/01 .locked). */
export function LockedBar({ text, action }: LockedBarProps) {
  return (
    <div className="locked" role="status">
      <span className="okdot m" aria-hidden="true" />
      <span>{text}</span>
      <span className="sp" style={{ flex: 1 }} />
      {action ? (
        <button type="button" className="btn tiny" onClick={action.onClick} disabled={action.disabled}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
