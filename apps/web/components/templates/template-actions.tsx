'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ApprovableButton } from '@/components/approvals/approvable-button';
import { useApprovalRequest } from '@/components/approvals/use-approval-request';
import { deleteTemplateAction, recordTemplateForDeletionAction, submitTemplateAction } from '@/lib/actions/templates';
import { useRealtime } from '@/lib/realtime/use-realtime';

/**
 * Delete (Head, message_templates.delete): always a proposal. Once a checker
 * approves, the worker deletes it at the provider (which may block the name for
 * a while, WhatsApp for 30 days); a draft the provider never saw goes at once.
 * A template made in the provider's console is recorded in OCSO first.
 */
export function DeleteTemplateButton({ channelId, templateId, recordId, name, draft, disabled }: { channelId: string; templateId: string; recordId: string | null; name: string; draft: boolean; disabled?: boolean }) {
  const approval = useApprovalRequest();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const write = (choice?: Parameters<typeof deleteTemplateAction>[2]) => deleteTemplateAction(channelId, templateId, choice);
  if (recordId) {
    return (
      <ApprovableButton
        always
        label="Delete"
        ariaLabel={`Delete ${name}`}
        buttonClass="btn tiny ghost"
        tone="danger"
        title={`Delete ${name}`}
        confirmLabel="Delete"
        disabled={disabled ?? false}
        target={{ objectKind: 'message_template', objectId: recordId, title: `Delete template ${name}` }}
        write={write}
      >
        {draft ? 'The draft is discarded once a checker approves.' : 'Once a checker approves, it is deleted at the provider; the provider may block the name for a while (WhatsApp: 30 days).'}
      </ApprovableButton>
    );
  }
  return (
    <>
      <button
        type="button"
        className="btn tiny ghost"
        aria-label={`Delete ${name}`}
        disabled={disabled || pending || approval.pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const recorded = await recordTemplateForDeletionAction(channelId, templateId);
            if (!recorded.ok) return setError(recorded.message);
            approval.run({ objectKind: 'message_template', objectId: recorded.data.recordId, title: `Delete template ${name}` }, write, { always: true });
          })
        }
      >
        Delete
      </button>
      {error || approval.error || approval.notice ? <span className="mono-sm">{error ?? approval.error ?? approval.notice}</span> : null}
      {approval.modal}
    </>
  );
}

/** Submit a draft to the provider for review: a checker approves first; the provider never sees an unapproved draft. */
export function SubmitDraftButton({ channelId, recordId, name, disabled }: { channelId: string; recordId: string; name: string; disabled?: boolean }) {
  return (
    <ApprovableButton
      always
      label="Submit for approval"
      ariaLabel={`Submit ${name} for approval`}
      buttonClass="btn tiny accent"
      title={`Submit ${name}`}
      confirmLabel="Submit"
      disabled={disabled ?? false}
      target={{ objectKind: 'message_template', objectId: recordId, title: `Submit template ${name}` }}
      write={(approval) => submitTemplateAction(channelId, recordId, approval)}
    >
      A checker approves it, then it goes to the provider for review.
    </ApprovableButton>
  );
}

/** Review results arrive live: the list refreshes on a status change or another template change. */
export function TemplatesLive({ channelId }: { channelId: string }) {
  const router = useRouter();
  useRealtime({
    types: ['message_template.status_changed', 'config.changed'],
    onEvent: (event) => {
      if (event.type === 'message_template.status_changed' ? event.payload.channelId === channelId : event.type === 'config.changed' && event.payload.area === 'message_templates') router.refresh();
    },
    onReconnect: () => router.refresh(),
  });
  return null;
}
