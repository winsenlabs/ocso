'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { resolveAction, returnToAiAction, transferAction } from '@/lib/actions/conversations';
import type { Option } from '@/lib/api/conversations';
import { withTag } from './lib/tags';
import { useActionRunner } from './lib/use-action';
import { TagInput } from './tag-input';

interface DialogProps {
  conversationId: string;
  onClose: () => void;
}

function Footer({ pending, label, onCancel, disabled }: { pending: boolean; label: string; onCancel: () => void; disabled?: boolean }) {
  return (
    <>
      <span className="sp" />
      <button type="button" className="btn ghost" onClick={onCancel}>
        Cancel
      </button>
      <button type="submit" form="ws-dialog-form" className="btn accent" disabled={pending || disabled}>
        {pending ? 'Working…' : label}
      </button>
    </>
  );
}

/** Return to AI (docs/archive/specs/09 §4): the agent resumes on the next customer message with this handover summary. */
export function ReturnToAiDialog({ conversationId, agentName, passedNotes, onClose }: DialogProps & { agentName: string; passedNotes: number }) {
  const [summary, setSummary] = useState('');
  const { pending, error, run } = useActionRunner();
  return (
    <Modal title={`Return to ${agentName}`} sub="handover summary" onClose={onClose} footer={<Footer pending={pending} label="Return to AI" onCancel={onClose} disabled={!summary.trim()} />}>
      <form
        id="ws-dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => returnToAiAction(conversationId, summary)).then((ok) => ok && onClose());
        }}
        style={{ display: 'grid', gap: 12 }}
      >
        <p className="mono-sm" style={{ margin: 0 }}>
          {agentName} stays silent until the customer writes again, then answers with this summary
          {passedNotes > 0 ? ` and ${passedNotes} internal note${passedNotes === 1 ? '' : 's'} marked “pass to agent”` : ''} as context.
        </p>
        <div className="fld">
          <label htmlFor="ws-handover">Handover summary</label>
          <textarea id="ws-handover" rows={4} value={summary} maxLength={4000} onChange={(e) => setSummary(e.target.value)} placeholder="What you did, what was agreed, what the agent should know next." data-autofocus />
        </div>
        {error ? (
          <span className="err" role="alert" style={{ color: 'var(--danger)', fontSize: 12 }}>
            {error}
          </span>
        ) : null}
      </form>
    </Modal>
  );
}

/** Resolve with an optional disposition and tags added to the conversation's tags. */
export function ResolveDialog({ conversationId, currentTags, onClose }: DialogProps & { currentTags: readonly string[] }) {
  const [disposition, setDisposition] = useState('');
  const [added, setAdded] = useState<string[]>([]);
  const { pending, error, run } = useActionRunner();
  const addTag = (raw: string) => {
    const edit = withTag([...currentTags, ...added], raw);
    if (!edit.ok) return edit.message;
    const tag = edit.tags[edit.tags.length - 1];
    if (edit.changed && tag) setAdded((a) => [...a, tag]);
    return null;
  };
  return (
    <Modal title="Resolve conversation" onClose={onClose} footer={<Footer pending={pending} label="Resolve" onCancel={onClose} />} maxWidth={480}>
      <form
        id="ws-dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => resolveAction(conversationId, disposition, added)).then((ok) => ok && onClose());
        }}
        style={{ display: 'grid', gap: 12 }}
      >
        <div className="fld">
          <label htmlFor="ws-disposition">Disposition (optional)</label>
          <input id="ws-disposition" value={disposition} maxLength={200} onChange={(e) => setDisposition(e.target.value)} placeholder="e.g. duplicate debit reversed" data-autofocus />
          <span className="hint">recorded on the conversation and in the audit log</span>
        </div>
        <div className="fld">
          <label htmlFor="ws-resolve-tags">Tags (optional)</label>
          {currentTags.length + added.length > 0 ? (
            <div className="tag-row" role="group" aria-label="Tags after resolving">
              {currentTags.map((t) => (
                <span className="chip" key={t} title="already on the conversation">
                  {t}
                </span>
              ))}
              {added.map((t) => (
                <span className="chip accent tagchip" key={t}>
                  {t}
                  <button type="button" aria-label={`Remove tag ${t}`} onClick={() => setAdded((a) => a.filter((x) => x !== t))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <TagInput id="ws-resolve-tags" label="Add tag on resolve" present={[...currentTags, ...added]} onAdd={addTag} placeholder="add a tag, then Enter" inline />
          <span className="hint">added to the conversation’s tags when it resolves</span>
        </div>
        {error ? (
          <span role="alert" style={{ color: 'var(--danger)', fontSize: 12 }}>
            {error}
          </span>
        ) : null}
      </form>
    </Modal>
  );
}

/** Transfer to another queue (anyone who may transfer) or a named person (leads with assign rights). */
export function TransferDialog({
  conversationId,
  queues,
  users,
  currentQueueId,
  currentAgentName,
  onClose,
}: DialogProps & { queues: Array<Option & { agentName?: string | null }>; users: Option[]; currentQueueId: string | null; currentAgentName?: string | undefined }) {
  const [queueId, setQueueId] = useState('');
  const chosen = queues.find((q) => q.id === queueId);
  const [userId, setUserId] = useState('');
  const { pending, error, run } = useActionRunner();
  const target = { ...(queueId ? { queueId } : {}), ...(userId ? { userId } : {}) };
  return (
    <Modal title="Transfer conversation" sub="it waits for a human again" onClose={onClose} footer={<Footer pending={pending} label="Transfer" onCancel={onClose} disabled={!queueId && !userId} />} maxWidth={480}>
      <form
        id="ws-dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => transferAction(conversationId, target)).then((ok) => ok && onClose());
        }}
        style={{ display: 'grid', gap: 12 }}
      >
        {queues.length === 0 && users.length === 0 ? <p className="mono-sm">No queues are available to transfer to.</p> : null}
        {queues.length > 0 ? (
          <div className="fld">
            <label htmlFor="ws-transfer-queue">Queue</label>
            <select id="ws-transfer-queue" value={queueId} onChange={(e) => setQueueId(e.target.value)} data-autofocus>
              <option value="">{users.length ? 'Keep the current queue' : 'Choose a queue'}</option>
              {queues.map((q) => (
                <option key={q.id} value={q.id} disabled={q.id === currentQueueId && !users.length}>
                  {q.name}
                  {q.agentName ? ` · ${q.agentName}` : ''}
                  {q.id === currentQueueId ? ' (current)' : ''}
                </option>
              ))}
            </select>
            {chosen ? (
              // The queue is the service unit: its one AI agent takes the conversation (PM/research/11 §5.5).
              <span className="hint" role="status">
                {chosen.agentName
                  ? chosen.agentName === currentAgentName
                    ? `${chosen.agentName} stays the agent.`
                    : `Receiving agent: ${chosen.agentName}${currentAgentName ? ` (instead of ${currentAgentName})` : ''} — it gets the history and a handover.`
                  : 'This queue has no AI agent: the current agent stays.'}
              </span>
            ) : null}
          </div>
        ) : null}
        {users.length > 0 ? (
          <div className="fld">
            <label htmlFor="ws-transfer-user">Person (offered to them)</label>
            <select id="ws-transfer-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Anyone in the queue</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {error ? (
          <span role="alert" style={{ color: 'var(--danger)', fontSize: 12 }}>
            {error}
          </span>
        ) : null}
      </form>
    </Modal>
  );
}
