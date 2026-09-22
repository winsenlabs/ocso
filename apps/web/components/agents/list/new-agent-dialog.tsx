'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { createAgentAction } from '@/lib/actions/agents';
import { CONVERSATION_TYPES, type ConversationType } from '../data/agent-schemas';
import type { Option } from '../data/options';
import { CONVERSATION_TYPE_LABELS } from '../lib/labels';
import { ownerProblem, type TeamRef } from '../lib/owners';
import { useAgentAction } from '../shared/use-action';

interface Props {
  profiles: Option[] | null;
  queues: Option[] | null;
  channels: Option[] | null;
  /** The lead's own teams: an agent is owned by at least one of them (ADR-026). */
  ownerTeams: TeamRef[];
}

/**
 * "New agent" (design/02 list): a named AI employee starts as a DRAFT with an
 * initial prompt version, owned by one or more of the lead's teams; it goes
 * live from its page once a model profile is set.
 */
export function NewAgentButton(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn accent" onClick={() => setOpen(true)}>
        New agent
      </button>
      {open ? <NewAgentDialog {...props} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function NewAgentDialog({ profiles, queues, channels, ownerTeams, onClose }: Props & { onClose: () => void }) {
  const router = useRouter();
  const action = useAgentAction();
  const [type, setType] = useState<ConversationType>('SUPPORT');
  const [picked, setPicked] = useState<string[]>([]);
  // One team: it is the owner. Several: the lead chooses (the first is preselected).
  const [owners, setOwners] = useState<string[]>(ownerTeams.slice(0, 1).map((t) => t.id));
  const ownersProblem = ownerProblem(owners);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (ownersProblem) return action.setError(ownersProblem);
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '');
    const id = (name: string) => text(name) || null;
    action.run(
      () =>
        createAgentAction({
          name: text('name'),
          purpose: text('purpose'),
          conversationType: type,
          description: text('description'),
          modelProfileId: id('modelProfileId'),
          defaultQueueId: id('defaultQueueId'),
          channelIds: picked,
          teamIds: owners,
        }),
      (data) => router.push(`/agents/${data.id}`),
    );
  }

  return (
    <Modal
      title="New virtual agent"
      sub="starts as a draft · changes are versioned"
      onClose={() => !action.pending && onClose()}
      maxWidth={620}
      footer={
        <>
          <span className="mono-sm">an initial prompt version is created from the type</span>
          <span className="sp" />
          <button type="button" className="btn" onClick={onClose} disabled={action.pending}>
            Cancel
          </button>
          <button type="submit" form="new-agent" className="btn accent" disabled={action.pending}>
            {action.pending ? 'Creating…' : 'Create agent'}
          </button>
        </>
      }
    >
      <form id="new-agent" className="agent-form" onSubmit={submit}>
        {action.error ? <AlertBanner tone="error" style={{ margin: 0 }}>{action.error}</AlertBanner> : null}
        <div className="fld-row">
          <div className="fld">
            <label htmlFor="na-name">Name</label>
            <input id="na-name" name="name" required maxLength={80} placeholder="Maya" data-autofocus />
          </div>
          <div className="fld">
            <label htmlFor="na-type">Conversation type</label>
            <select id="na-type" value={type} onChange={(e) => setType(e.target.value as ConversationType)}>
              {CONVERSATION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CONVERSATION_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <fieldset className="fld" style={{ border: 'none', padding: 0, margin: 0 }}>
          <legend style={{ fontSize: 12, color: 'var(--ink-2)', fontWeight: 500, marginBottom: 5 }}>Owning team</legend>
          <div className="checks">
            {ownerTeams.map((t) => (
              <label key={t.id}>
                <input
                  type="checkbox"
                  checked={owners.includes(t.id)}
                  onChange={(e) => setOwners((prev) => (e.target.checked ? [...prev, t.id] : prev.filter((x) => x !== t.id)))}
                />
                {t.name}
              </label>
            ))}
          </div>
          <span className="hint">{ownersProblem ?? 'only CS Leads of the owning teams see and manage this agent'}</span>
        </fieldset>
        <div className="fld">
          <label htmlFor="na-purpose">Purpose</label>
          <input id="na-purpose" name="purpose" maxLength={200} placeholder="Customer Support" />
          <span className="hint">shown under the name and used in the initial identity component</span>
        </div>
        <div className="fld">
          <label htmlFor="na-description">Description</label>
          <textarea id="na-description" name="description" maxLength={2000} rows={3} placeholder="What this agent handles, and when it hands off." />
        </div>
        <div className="fld-row">
          <div className="fld">
            <label htmlFor="na-profile">Model profile</label>
            <select id="na-profile" name="modelProfileId" defaultValue="">
              <option value="">Assign later</option>
              {profiles?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="hint">{profiles?.length ? 'required before the agent goes live' : 'no model profiles yet — a Tech Admin adds them under Connections'}</span>
          </div>
          <div className="fld">
            <label htmlFor="na-queue">Default queue</label>
            <select id="na-queue" name="defaultQueueId" defaultValue="" disabled={!queues}>
              <option value="">None</option>
              {queues?.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.name}
                </option>
              ))}
            </select>
            <span className="hint">where handoffs go unless a rule targets another queue</span>
          </div>
        </div>
        {channels?.length ? (
          <fieldset className="fld" style={{ border: 'none', padding: 0, margin: 0 }}>
            <legend style={{ fontSize: 12, color: 'var(--ink-2)', fontWeight: 500, marginBottom: 5 }}>Channels</legend>
            <div className="checks">
              {channels.map((c) => (
                <label key={c.id}>
                  <input
                    type="checkbox"
                    checked={picked.includes(c.id)}
                    onChange={(e) => setPicked((prev) => (e.target.checked ? [...prev, c.id] : prev.filter((x) => x !== c.id)))}
                  />
                  {c.name}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
      </form>
    </Modal>
  );
}
