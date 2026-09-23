'use client';

import { useState, type FormEvent } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { updateAgentAction } from '@/lib/actions/agents';
import { CONVERSATION_TYPES, type AgentDetail, type ConversationType } from '../data/agent-schemas';
import type { Option } from '../data/options';
import { CONVERSATION_TYPE_LABELS, MID_TURN_LABELS } from '../lib/labels';
import { useApprovalRequest } from '@/components/approvals/use-approval-request';

function ProfileSelect({ id, name, label, hint, value, profiles }: { id: string; name: string; label: string; hint: string; value: string | null; profiles: Option[] }) {
  return (
    <div className="fld">
      <label htmlFor={id}>{label}</label>
      <select id={id} name={name} defaultValue={value ?? ''}>
        <option value="">None</option>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.caption ? ` — ${p.caption}` : ''}
          </option>
        ))}
      </select>
      <span className="hint">{hint}</span>
    </div>
  );
}

/** Identity, model profiles and runtime settings of one agent (AGENTS_MANAGE). */
export function SettingsForm({ agent, profiles }: { agent: AgentDetail; profiles: Option[] }) {
  // A draft saves directly; a live agent's change becomes a proposal for a checker (PM/research/11 §4).
  const action = useApprovalRequest();
  const [saved, setSaved] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '');
    const on = (k: string) => f.get(k) === 'on';
    setSaved(false);
    action.run(
      { objectKind: 'agent', objectId: agent.id, title: `Change ${agent.name}` },
      (approval) =>
        updateAgentAction(agent.id, {
          name: text('name'),
          purpose: text('purpose'),
          conversationType: text('conversationType') as ConversationType,
          description: text('description'),
          modelProfileId: text('modelProfileId') || null,
          summarizerProfileId: text('summarizerProfileId') || null,
          copilotProfileId: text('copilotProfileId') || null,
          copilotEnabled: on('copilotEnabled'),
          midTurnPolicy: text('midTurnPolicy') as AgentDetail['midTurnPolicy'],
          maxToolSteps: Number(text('maxToolSteps')),
          multimodal: { imageInput: on('imageInput'), documentInput: on('documentInput'), audioInput: on('audioInput'), maxMediaPerTurn: Number(text('maxMediaPerTurn')) },
        }, approval),
      { onApplied: (proposed) => setSaved(proposed === null) },
    );
  }

  return (
    <form className="agent-form" onSubmit={submit} aria-label="Agent settings">
      {action.error ? <AlertBanner tone="error" style={{ margin: 0 }}>{action.error}</AlertBanner> : null}
      {saved && !action.pending ? <AlertBanner style={{ margin: 0 }}>Settings saved · the agent&apos;s cached configuration was refreshed.</AlertBanner> : null}
      {action.notice ? <AlertBanner style={{ margin: 0 }}>{action.notice}</AlertBanner> : null}
      {action.modal}
      <div className="g g2">
        <fieldset className="agent-fieldset">
          <legend>Identity</legend>
          <div className="fld-row">
            <div className="fld">
              <label htmlFor="st-name">Name</label>
              <input id="st-name" name="name" required maxLength={80} defaultValue={agent.name} />
            </div>
            <div className="fld">
              <label htmlFor="st-type">Conversation type</label>
              <select id="st-type" name="conversationType" defaultValue={agent.conversationType}>
                {CONVERSATION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {CONVERSATION_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="fld">
            <label htmlFor="st-purpose">Purpose</label>
            <input id="st-purpose" name="purpose" maxLength={200} defaultValue={agent.purpose} />
          </div>
          <div className="fld">
            <label htmlFor="st-description">Description</label>
            <textarea id="st-description" name="description" rows={4} maxLength={2000} defaultValue={agent.description} />
            <span className="hint">for people; the prompt&apos;s Identity component is what the model reads</span>
          </div>
        </fieldset>
        <fieldset className="agent-fieldset">
          <legend>Model profiles · owned by the Tech admin</legend>
          <ProfileSelect id="st-model" name="modelProfileId" label="Conversation model" hint="answers customers · required to go live" value={agent.modelProfileId} profiles={profiles} />
          <ProfileSelect id="st-summarizer" name="summarizerProfileId" label="Summarizer" hint="rolling summaries and handover notes" value={agent.summarizerProfileId} profiles={profiles} />
          <ProfileSelect id="st-copilot" name="copilotProfileId" label="Copilot" hint="suggestions for humans handling this agent's conversations" value={agent.copilotProfileId} profiles={profiles} />
          <label className="toggle-row">
            <input type="checkbox" name="copilotEnabled" defaultChecked={agent.copilotEnabled} /> Copilot suggestions for humans
          </label>
        </fieldset>
      </div>
      <fieldset className="agent-fieldset">
        <legend>Runtime</legend>
        <div className="fld-row">
          <div className="fld">
            <label htmlFor="st-midturn">Customer writes while the agent is answering</label>
            <select id="st-midturn" name="midTurnPolicy" defaultValue={agent.midTurnPolicy}>
              {Object.entries(MID_TURN_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="st-steps">Max tool steps per turn</label>
            <input id="st-steps" name="maxToolSteps" type="number" min={1} max={20} required defaultValue={agent.maxToolSteps} />
          </div>
        </div>
        <div className="checks" role="group" aria-label="Customer media the agent reads">
          <label>
            <input type="checkbox" name="imageInput" defaultChecked={agent.multimodal.imageInput} /> Images
          </label>
          <label>
            <input type="checkbox" name="documentInput" defaultChecked={agent.multimodal.documentInput} /> Documents
          </label>
          <label>
            <input type="checkbox" name="audioInput" defaultChecked={agent.multimodal.audioInput} /> Audio
          </label>
        </div>
        <div className="fld" style={{ maxWidth: 240 }}>
          <label htmlFor="st-media">Max media per turn</label>
          <input id="st-media" name="maxMediaPerTurn" type="number" min={0} max={20} required defaultValue={agent.multimodal.maxMediaPerTurn} />
          <span className="hint">0–20 attachments per customer turn</span>
        </div>
      </fieldset>
      <div className="actions">
        <button type="submit" className="btn accent" disabled={action.pending}>
          {action.pending ? 'Saving…' : 'Save settings'}
        </button>
        <span className="mono-sm">slug {agent.slug} · recorded in the audit log</span>
      </div>
    </form>
  );
}
