'use client';

import { useState } from 'react';
import type { MessageSpec } from '@ocso/domain';
import { useApprovalRequest } from '@/components/approvals/use-approval-request';
import { draftRouterTemplateAction, submitForApprovalAction } from '@/lib/actions/routers';
import { templateName, withTemplate } from './lib/definition';

export interface TemplateChannel {
  id: string;
  name: string;
}

/**
 * A router message (PM/research/11 §5.3): free text, plus — per channel with
 * provider templates — the approved template sent instead when the channel's
 * session window is closed. "Create template for <channel>" drafts that
 * template from the text in one click, maps it here, and opens its approval
 * (the provider sees it only after a checker approves).
 */
export function MessageEditor({
  id,
  label,
  spec,
  onChange,
  channels,
  routerName,
  stepId,
  canEdit,
  onMapped,
}: {
  id: string;
  label: string;
  spec: MessageSpec;
  onChange: (spec: MessageSpec) => void;
  channels: readonly TemplateChannel[];
  routerName: string;
  stepId: string;
  canEdit: boolean;
  /** Persist the definition after a template was mapped (the draft must name it before its approval). */
  onMapped: (spec: MessageSpec) => Promise<boolean>;
}) {
  const approval = useApprovalRequest();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function createFor(channel: TemplateChannel) {
    setBusy(channel.id);
    setError(null);
    const drafted = await draftRouterTemplateAction(channel.id, { name: templateName(routerName, stepId), text: spec.text, language: 'en' });
    if (!drafted.ok) {
      setBusy(null);
      return setError(drafted.message);
    }
    const next = withTemplate(spec, channel.id, drafted.data.templateId);
    onChange(next);
    const saved = await onMapped(next);
    setBusy(null);
    if (!saved) return;
    approval.run(
      { objectKind: 'message_template', objectId: drafted.data.templateId, title: `Submit template ${templateName(routerName, stepId)} for ${channel.name}` },
      (choice) => submitForApprovalAction('message_template', drafted.data.templateId, 'CREATE', choice),
      { always: true },
    );
  }

  return (
    <div className="fld">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} value={spec.text} maxLength={1_000} rows={2} disabled={!canEdit} onChange={(e) => onChange({ ...spec, text: e.target.value })} />
      {channels.length ? (
        <div className="rt-templates" aria-label={`${label}: templates per channel`}>
          {channels.map((c) => {
            const mapped = spec.templates?.[c.id];
            return (
              <span key={c.id} className="rowsplit" style={{ gap: 6 }}>
                <span className="mono-sm">{c.name}:</span>
                {mapped ? (
                  <>
                    <span className="mono-sm">template {mapped.slice(0, 8)} · sent outside the session window</span>
                    {canEdit ? (
                      <button type="button" className="btn tiny ghost" onClick={() => onChange(withTemplate(spec, c.id, null))}>
                        Clear
                      </button>
                    ) : null}
                  </>
                ) : canEdit ? (
                  <button type="button" className="btn tiny" disabled={busy !== null || !spec.text.trim()} onClick={() => void createFor(c)}>
                    {busy === c.id ? 'Drafting…' : `Create template for ${c.name}`}
                  </button>
                ) : (
                  <span className="mono-sm">no template: free text only inside the session window</span>
                )}
              </span>
            );
          })}
        </div>
      ) : null}
      {error || approval.error || approval.notice ? (
        <span className={error || approval.error ? 'err' : 'hint'} role={error || approval.error ? 'alert' : 'status'}>
          {error ?? approval.error ?? approval.notice}
        </span>
      ) : null}
      {approval.modal}
    </div>
  );
}
