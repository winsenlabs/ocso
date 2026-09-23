'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { useApprovalRequest } from '@/components/approvals/use-approval-request';
import { createWebhookAction, refreshWebhooksAction, rotateWebhookSecretAction, testWebhookAction, updateWebhookAction } from '@/lib/actions/webhooks';
import { DeleteByApproval } from '../lifecycle-actions';
import type { Webhook } from '@/lib/api/webhooks';
import { ConfirmAction } from '../confirm-action';
import { CopyButton } from '../copy-button';
import { Input } from '../profiles/profile-fields';
import { useCloseTo } from '../routed-modal';
import { EventPicker } from './event-picker';

/** The signing secret is shown exactly once, after create or rotate. */
function SecretOnce({ secret }: { secret: string }) {
  return (
    <div className="confirm" role="status">
      <span className="cl">signing secret · shown once</span>
      <span className="cx">You won’t see this again. Store it in the receiver’s secret manager now; OCSO keeps only a reference.</span>
      <div className="rowsplit">
        <code className="secret-once" aria-label="Signing secret">
          {secret}
        </code>
        <CopyButton value={secret} what="signing secret" />
      </div>
    </div>
  );
}

/** Add / edit an outbound webhook (POST, PATCH /v1/webhooks); edit also sends tests, rotates the secret and shows deliveries. */
export function WebhookDialog({ webhook, eventTypes, closeHref, children }: { webhook: Webhook | null; eventTypes: string[]; closeHref: string; children: ReactNode }) {
  const close = useCloseTo(closeHref);
  const [name, setName] = useState(webhook?.name ?? '');
  const [url, setUrl] = useState(webhook?.url ?? 'https://');
  const [events, setEvents] = useState<string[]>(webhook?.events ?? []);
  const [secret, setSecret] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const approval = useApprovalRequest();

  function save() {
    setMessage(null);
    if (webhook) {
      // A draft saves directly; an approved subscription asks for a checker (a proposal).
      approval.run({ objectKind: 'webhook_subscription', objectId: webhook.id, title: `Change webhook ${webhook.name}` }, (choice) => updateWebhookAction(webhook.id, { name, url, events }, choice), {
        onApplied: () => setMessage({ tone: 'info', text: 'Saved · change recorded in the audit log' }),
      });
      return;
    }
    start(async () => {
      const r = await createWebhookAction({ name, url, events });
      if (r.ok) setSecret(r.data.signingSecret);
      else setMessage({ tone: 'error', text: r.message });
    });
  }

  function test() {
    if (!webhook) return;
    setMessage(null);
    start(async () => {
      const r = await testWebhookAction(webhook.id);
      if (!r.ok) setMessage({ tone: 'error', text: r.message });
      else if (r.data.ok) setMessage({ tone: 'info', text: `Test delivered · HTTP ${r.data.status ?? '—'}` });
      else setMessage({ tone: 'error', text: `Test failed · ${r.data.error ?? `HTTP ${r.data.status ?? '—'}`}` });
    });
  }

  const finish = () =>
    start(async () => {
      await refreshWebhooksAction();
      close();
    });

  if (secret && !webhook) {
    return (
      <Modal title={`Webhook ${name} created`} sub="signed with HMAC-SHA256" onClose={finish} maxWidth={620} footer={<><span className="sp" /><button type="button" className="btn accent" onClick={finish}>Done</button></>}>
        <SecretOnce secret={secret} />
      </Modal>
    );
  }

  return (
    <Modal
      title={webhook ? `Webhook · ${webhook.name}` : 'Add webhook endpoint'}
      sub="outbound · events are signed"
      onClose={close}
      maxWidth={720}
      footer={
        <>
          {webhook ? (
            <DeleteByApproval kind="webhook_subscription" id={webhook.id} name={webhook.name} detail="Once a second person approves, deliveries stop, pending deliveries are dropped and the signing secret is deleted." />
          ) : null}
          <span className="sp" />
          <button type="button" className="btn" onClick={close}>
            {webhook ? 'Close' : 'Cancel'}
          </button>
          {webhook ? (
            <button type="button" className="btn" onClick={test} disabled={pending}>
              Send test
            </button>
          ) : null}
          <button type="submit" form="webhook-form" className="btn accent" disabled={pending}>
            {pending ? 'Working…' : webhook ? 'Save' : 'Create endpoint'}
          </button>
        </>
      }
    >
      <div role="status" aria-live="polite">
        {message ? (
          <AlertBanner tone={message.tone} style={{ margin: 0 }}>
            {message.text}
          </AlertBanner>
        ) : null}
      </div>
      {secret ? <SecretOnce secret={secret} /> : null}
      <form
        id="webhook-form"
        noValidate
        style={{ display: 'grid', gap: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="fld-row">
          <Input id="wh-name" label="Name" value={name} onChange={setName} />
          <Input id="wh-url" label="Endpoint URL" value={url} onChange={setUrl} hint="https only" />
        </div>
        {webhook ? null : <span className="hint">A new webhook is a disabled draft: enable it from the list once saved (a second person approves).</span>}
        {approval.error || approval.notice ? <span className={approval.error ? 'err-text' : 'mono-sm'}>{approval.error ?? approval.notice}</span> : null}
        {approval.modal}
        <EventPicker eventTypes={eventTypes} value={events} onChange={setEvents} />
      </form>
      {webhook ? (
        <div className="rowsplit">
          <span className="mono-sm">signing secret · stored by reference, never shown again</span>
          <span className="sp" />
          <ConfirmAction
            label="Rotate secret"
            buttonClass="btn tiny"
            title={`Rotate the signing secret of ${webhook.name}`}
            confirmLabel="Rotate secret"
            run={async () => {
              const r = await rotateWebhookSecretAction(webhook.id);
              if (r.ok) setSecret(r.data.signingSecret);
              return r;
            }}
          >
            Deliveries are signed with the new secret right away; update the receiver before it rejects them. The new secret is shown once.
          </ConfirmAction>
        </div>
      ) : null}
      {children}
    </Modal>
  );
}
