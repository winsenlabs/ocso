'use client';

import { useRef, useState } from 'react';
import { addNoteAction, sendReplyAction } from '@/lib/actions/conversations';
import type { CopilotState, WorkspaceTool } from '@/lib/api/conversations';
import { CopilotBlock } from './copilot-block';
import { TemplateComposer } from './template-composer';
import { ToolAction } from './tool-action';
import { canReplyFreely, windowLine, type WindowState } from './lib/template';
import { useActionRunner } from './lib/use-action';
import { useAttachments } from './lib/use-attachments';
import { useNow } from './lib/use-now';

export type ComposerMode = 'reply' | 'template' | 'note' | 'tool';

export interface ComposerProps {
  conversationId: string;
  /** How to address the customer: first name, or "the customer" when unknown. */
  customerName: string;
  channelLabel: string;
  agentName: string;
  copilot: CopilotState;
  tools: WorkspaceTool[];
  can: { reply: boolean; note: boolean; runTools: boolean };
  /** The channel's customer-service window (null: the channel has none). */
  replyWindow?: WindowState | null | undefined;
  /** Channel whose approved templates the Template mode offers. */
  channelId?: string | null | undefined;
  /** The channel's kind supports message templates (its descriptor); `reviewer` names who approves them. */
  templates?: { reviewer: string } | null | undefined;
  /** Server render time, so the window countdown hydrates without a mismatch. */
  renderedAt?: number | undefined;
}

function newClientMessageId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Composer (design/01 .comp): reply to the customer, internal note (never
 * sent to the customer), or a tool action. Shown only while this human holds
 * the conversation; otherwise the locked bar explains why.
 */
export function Composer({ conversationId, customerName, channelLabel, agentName, copilot, tools, can, replyWindow = null, channelId = null, templates: terms = null, renderedAt }: ComposerProps) {
  const now = useNow(30_000, renderedAt);
  const line = windowLine(replyWindow, now);
  const freeReply = canReplyFreely(replyWindow, now);
  const templates = can.reply && terms !== null && channelId !== null;
  const [chosen, setMode] = useState<ComposerMode>(can.reply ? (freeReply || !templates ? 'reply' : 'template') : 'note');
  // The window can close while the composer is open: Reply becomes Template.
  const mode: ComposerMode = chosen === 'reply' && !freeReply && templates ? 'template' : chosen;
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const [passToAgent, setPassToAgent] = useState(false);
  const clientId = useRef(newClientMessageId());
  const { pending, error, clearError, run } = useActionRunner();
  const [sentFlash, setSentFlash] = useState<string | null>(null);
  const files = useAttachments(conversationId);
  const fileInput = useRef<HTMLInputElement>(null);

  const isNote = mode === 'note';
  const text = isNote ? note : reply;
  const setText = isNote ? setNote : setReply;

  const submit = () => {
    if ((!text.trim() && (isNote || files.items.length === 0)) || pending || files.uploading) return;
    if (isNote) {
      void run(() => addNoteAction(conversationId, note, passToAgent)).then((ok) => {
        if (ok) {
          setNote('');
          setPassToAgent(false);
          setSentFlash('Note added · visible to CS staff only');
        }
      });
    } else {
      const attachments = files.items.map((a) => ({ partType: a.partType, media: a.media }));
      void run(() => sendReplyAction(conversationId, reply, clientId.current, attachments)).then((ok) => {
        if (ok) {
          setReply('');
          files.clear();
          clientId.current = newClientMessageId();
          setSentFlash(`Sent to ${customerName}`);
        }
      });
    }
  };

  const modes: Array<{ key: ComposerMode; label: string; allowed: boolean }> = [
    { key: 'reply', label: 'Reply to customer', allowed: can.reply && (freeReply || !templates) },
    { key: 'template', label: 'Template', allowed: templates },
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
        <span className="mono-sm">{channelLabel.toLowerCase()} · {mode === 'template' ? 'approved templates' : 'text and attachments'}</span>
      </div>
      {line ? (
        <p className={`winline ${line.tone}`}>
          <span className={line.tone === 'closed' ? 'okdot w' : 'okdot'} aria-hidden="true" />
          {line.text}
        </p>
      ) : null}

      {mode === 'reply' ? <CopilotBlock conversationId={conversationId} agentName={agentName} initial={copilot} onInsert={(t) => setReply((cur) => (cur.trim() ? `${cur.trim()}\n\n${t}` : t))} /> : null}

      {mode === 'template' && channelId ? (
        <>
          <TemplateComposer conversationId={conversationId} channelId={channelId} customerName={customerName} reopen={false} reviewer={terms?.reviewer} onSent={setSentFlash} />
          {sentFlash ? (
            <p className="mono-sm tplnote" role="status">
              {sentFlash}
            </p>
          ) : null}
        </>
      ) : mode === 'tool' ? (
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
          {!isNote && files.items.length > 0 ? (
            <div className="attachments" aria-label="Attachments">
              {files.items.map((a) => (
                <span key={a.id} className="fchip">
                  {a.filename}
                  <button type="button" className="icon-btn" aria-label={`Remove ${a.filename}`} onClick={() => files.remove(a.id)}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="brow">
            {!isNote ? (
              <>
                <input ref={fileInput} type="file" multiple hidden accept="image/*,application/pdf,audio/*,video/*" onChange={(e) => {
                  void files.add(e.target.files);
                  e.target.value = '';
                }} />
                <button type="button" className="btn tiny" onClick={() => fileInput.current?.click()} disabled={files.uploading}>
                  {files.uploading ? 'Uploading…' : 'Attach'}
                </button>
              </>
            ) : null}
            {isNote ? (
              <label className="pass">
                <input type="checkbox" checked={passToAgent} onChange={(e) => setPassToAgent(e.target.checked)} />
                pass to {agentName} on return
              </label>
            ) : null}
            <span className="mono-sm">{isNote ? 'visible to Lead and Service member only' : 'shift + enter for a new line'}</span>
            <span className="sp" style={{ flex: 1 }} />
            {error || files.error ? (
              <span className="err" role="alert">
                {error ?? files.error}
              </span>
            ) : sentFlash ? (
              <span className="mono-sm" role="status">
                {sentFlash}
              </span>
            ) : null}
            <button type="submit" className={isNote ? 'btn tiny primary' : 'btn tiny accent'} disabled={pending || files.uploading || (!text.trim() && (isNote || files.items.length === 0))}>
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
  /** A second way forward, e.g. "Reopen with a template" on a resolved conversation whose channel has templates. */
  secondary?: { label: string; onClick: () => void; disabled?: boolean } | null | undefined;
}

/** Composer replacement when this human cannot write (design/01 .locked). */
export function LockedBar({ text, action, secondary }: LockedBarProps) {
  return (
    <div className="locked" role="status">
      <span className="okdot m" aria-hidden="true" />
      <span>{text}</span>
      <span className="sp" style={{ flex: 1 }} />
      {secondary ? (
        <button type="button" className="btn tiny ghost" onClick={secondary.onClick} disabled={secondary.disabled}>
          {secondary.label}
        </button>
      ) : null}
      {action ? (
        <button type="button" className="btn tiny" onClick={action.onClick} disabled={action.disabled}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
