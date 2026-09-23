'use client';

import { useMemo, useState, useTransition } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { useApprovalRequest } from '@/components/approvals/use-approval-request';
import { createChannelAction, updateChannelAction, type SavedChannel } from '@/lib/actions/channels';
import type { Channel, ChannelKind } from '@/lib/api/channels';
import type { AgentLite } from '@/lib/api/mcp';
import { Input } from '../profiles/profile-fields';
import { useCloseTo } from '../routed-modal';
import { ChannelNextSteps } from './next-steps';
import { RevealedSecrets } from './provider-steps';
import { SecretFields } from './secret-fields';
import { SettingsFields } from './settings-fields';
import { buildSettings, initialSettingsValues, settingsGroups, splitProblems } from './settings-form';

interface Props {
  kinds: ChannelKind[];
  channel: Channel | null;
  initialKind: string | null;
  agents: AgentLite[];
  publicOrigin: string;
  closeHref: string;
}

const kindLabel = (k: ChannelKind | undefined) => k?.label ?? k?.kind ?? 'Channel';

/** Add / edit a channel (POST, PATCH /v1/channels) from the adapter's descriptor; then shows how to connect it. */
export function ChannelDialog({ kinds, channel, initialKind, agents, publicOrigin, closeHref }: Props) {
  const close = useCloseTo(closeHref);
  const [kind, setKind] = useState(channel?.kind ?? initialKind ?? kinds[0]?.kind ?? '');
  const def = kinds.find((k) => k.kind === kind);
  const group = useMemo(() => settingsGroups(def?.settingsSchema ?? {}), [def]);
  const [name, setName] = useState(channel?.name ?? kindLabel(def));
  const [values, setValues] = useState(() => initialSettingsValues(group, channel?.settings ?? null));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [generated, setGenerated] = useState<Record<string, string>>({});
  const [agentId, setAgentId] = useState(channel?.defaultAgentId ?? '');
  const [errors, setErrors] = useState<{ settings: Record<string, string>; secrets: Record<string, string>; fields: Record<string, string> }>({ settings: {}, secrets: {}, fields: {} });
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedChannel | null>(null);
  const [pending, start] = useTransition();
  const approval = useApprovalRequest();
  const stored = useMemo(() => (channel ? new Set(Object.keys(channel.secretRefs)) : null), [channel]);

  function chooseKind(next: string) {
    const nextDef = kinds.find((k) => k.kind === next);
    if (name === '' || name === kindLabel(def)) setName(kindLabel(nextDef));
    setKind(next);
    setValues(initialSettingsValues(settingsGroups(nextDef?.settingsSchema ?? {}), null));
    setSecrets({});
    setGenerated({});
    setErrors({ settings: {}, secrets: {}, fields: {} });
  }

  function save() {
    if (!def) return;
    const built = buildSettings(group, values);
    const typed = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v.trim() !== ''));
    const secretErrors: Record<string, string> = {};
    // The configuration is checked on every save (and again when activation is approved).
    for (const f of def.secrets) {
      const missing = f.required && !typed[f.key] && !stored?.has(f.key) && !(f.generate === 'server' && !channel);
      if (missing) secretErrors[f.key] = 'Required';
    }
    const fieldErrors: Record<string, string> = name.trim() ? {} : { name: 'Enter a name' };
    setErrors({ settings: built.errors, secrets: secretErrors, fields: fieldErrors });
    setMessage(null);
    if (Object.keys(built.errors).length || Object.keys(secretErrors).length || Object.keys(fieldErrors).length) return;
    const body = { name: name.trim(), settings: built.settings, secrets: typed, defaultAgentId: agentId || null };
    const done = (r: Awaited<ReturnType<typeof createChannelAction>>) => {
      if (r.ok) {
        setSecrets({});
        if (r.data) setSaved(r.data);
        return;
      }
      if (r.code === 'approval_required') return;
      const problems = splitProblems(r.message);
      setErrors({ settings: problems.settings, secrets: problems.secrets, fields: problems.fields });
      const matched = Object.keys(problems.settings).length + Object.keys(problems.secrets).length + Object.keys(problems.fields).length;
      setMessage(matched ? `The API rejected the configuration${problems.other.length ? `: ${problems.other.join('; ')}` : ' — see the fields below.'}` : r.message);
    };
    if (!channel) {
      start(async () => done(await createChannelAction({ ...body, kind })));
      return;
    }
    // A draft saves directly; an approved channel asks for a checker (submit modal) and becomes a proposal.
    approval.run({ objectKind: 'channel', objectId: channel.id, title: `Change channel ${channel.name}` }, async (choice) => {
      const r = await updateChannelAction(channel.id, body, choice);
      if (!r.ok && r.code !== 'approval_required') done(r);
      return r;
    }, { onApplied: (data) => done({ ok: true, data }) });
  }

  const origins = String(values['allowedOrigins'] ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const authMode = typeof values['auth.mode'] === 'string' && values['auth.mode'] ? values['auth.mode'] : 'anonymous';
  // OCSO-generated keys the admin must copy now (the create response carries them once).
  const revealed = saved?.revealedSecrets
    ? (def?.secrets ?? []).filter((f) => saved.revealedSecrets?.[f.key]).map((f) => ({ key: f.key, label: f.label, value: saved.revealedSecrets![f.key]! }))
    : [];
  const kindInfo = { inboundWebhook: def?.inboundWebhook ?? false, embeddable: def?.embeddable ?? false, label: kindLabel(def), connectionCheck: def?.connectionCheck ?? false, setupSteps: def?.setupSteps ?? [] };
  // Client-generated secrets are for pasting elsewhere (e.g. the provider's console): shown once more with the next steps.
  const generatedSecrets = (def?.secrets ?? []).filter((f) => generated[f.key]).map((f) => ({ label: f.label, value: generated[f.key]! }));

  if (saved) {
    return (
      <Modal title={`${saved.name} saved`} sub="changes are audited" onClose={close} maxWidth={660} footer={<><span className="sp" /><button type="button" className="btn accent" onClick={close}>Done</button></>}>
        <AlertBanner style={{ margin: 0 }} title={channel ? 'Channel updated.' : 'Channel created.'}>
          Secrets were stored by reference; the form no longer holds them.
        </AlertBanner>
        <RevealedSecrets secrets={revealed} />
        <ChannelNextSteps channel={saved} kind={kindInfo} publicOrigin={publicOrigin} generated={generatedSecrets} allowedOrigins={origins} authMode={authMode} />
      </Modal>
    );
  }

  return (
    <Modal
      title={channel ? `Edit ${channel.name}` : 'Add channel'}
      sub="secrets are write-only"
      onClose={close}
      maxWidth={720}
      footer={
        <>
          <span className="mono-sm">{!channel || channel.status === 'DRAFT' ? 'a draft receives nothing until its activation is approved' : 'changes to a live channel are approved by a second person'}</span>
          <span className="sp" />
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" form="channel-form" className="btn accent" disabled={pending || approval.pending || !def}>
            {pending || approval.pending ? 'Saving…' : channel ? (channel.approval?.updateNeedsApproval ? 'Submit change' : 'Save channel') : 'Add channel'}
          </button>
        </>
      }
    >
      <form id="channel-form" noValidate style={{ display: 'grid', gap: 14 }} onSubmit={(e) => (e.preventDefault(), save())}>
        {message || approval.error ? (
          <AlertBanner tone="error" style={{ margin: 0 }}>
            {message ?? approval.error}
          </AlertBanner>
        ) : null}
        {approval.notice ? (
          <AlertBanner tone="info" style={{ margin: 0 }}>
            {approval.notice}
          </AlertBanner>
        ) : null}
        {approval.modal}
        {channel ? null : (
          <div className="fld">
            <label htmlFor="ch-kind">Channel type</label>
            <select id="ch-kind" value={kind} onChange={(e) => chooseKind(e.target.value)}>
              {kinds.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {kindLabel(k)}
                </option>
              ))}
            </select>
            {def?.description ? <span className="hint">{def.description}</span> : null}
          </div>
        )}
        <Input id="ch-name" label="Name" value={name} onChange={setName} error={errors.fields['name']} />
        <div className="fld">
          <label htmlFor="ch-agent">Default virtual agent</label>
          <select id="ch-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">No default agent</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <span className="hint">answers new conversations on this channel{agents.length ? '' : ' · no agents exist yet'}</span>
        </div>
        <fieldset className="conn-fieldset">
          <legend>Settings</legend>
          <SettingsFields group={group} values={values} errors={errors.settings} onChange={(path, v) => setValues((prev) => ({ ...prev, [path]: v }))} />
        </fieldset>
        <fieldset className="conn-fieldset">
          <legend>Secrets · write-only</legend>
          <SecretFields
            fields={def?.secrets ?? []}
            values={secrets}
            generated={generated}
            errors={errors.secrets}
            stored={stored}
            onChange={(key, value, isGenerated) => {
              setSecrets((prev) => ({ ...prev, [key]: value }));
              if (isGenerated) setGenerated((prev) => ({ ...prev, [key]: value }));
            }}
          />
        </fieldset>
        {channel ? <ChannelNextSteps channel={channel} kind={kindInfo} publicOrigin={publicOrigin} allowedOrigins={origins} authMode={authMode} /> : null}
      </form>
    </Modal>
  );
}
