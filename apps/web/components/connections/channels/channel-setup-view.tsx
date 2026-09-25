'use client';

import type { ReactNode } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import type { Channel, ChannelKind } from '@/lib/api/channels';
import { ChannelTest } from './channel-test';
import { WebhookUrlRow, useTroubleshooting } from './next-steps';
import { GeneratedSecrets } from './provider-steps';
import { inboundWebhookUrl, missingRequiredSecrets } from './settings-form';
import { SetupGuide, Troubleshooting } from './setup-guide';

interface Props {
  channel: Channel;
  kind: ChannelKind;
  label: string;
  publicOrigin: string;
  /** Secrets the channel holds (names). */
  stored: ReadonlySet<string>;
  footer: ReactNode;
  /** Secrets generated in this dialog for the provider's console (e.g. a verify token), shown until it closes. */
  generated: ReadonlyArray<{ label: string; value: string }>;
  onClose: () => void;
  onSubmit: () => void;
  /** The dialog's banners and OCSO's settings and secrets fields. */
  children: { banners: ReactNode; fields: ReactNode; pendingKeys: readonly string[] };
}

/**
 * Phase two of a webhook kind: the saved channel inside its kind's setup guide. A draft gets the guide with
 * OCSO's form in the step where values are pasted, and what it still needs before activation; a live channel
 * gets the form first and the guide folded under it. Then the connection test and troubleshooting.
 */
export function ChannelSetupView({ channel, kind, label, publicOrigin, stored, footer, generated, onClose, onSubmit, children }: Props) {
  const trouble = useTroubleshooting();
  const url = inboundWebhookUrl(publicOrigin, channel) ?? '';
  const draft = channel.status === 'DRAFT';
  const stillNeeded = missingRequiredSecrets(kind.secrets, stored);
  const guide = (
    <SetupGuide
      steps={kind.setupGuide}
      files={kind.setupFiles}
      ctx={{ webhookUrl: url || null, settings: channel.settings }}
      channelId={channel.id}
      label={label}
      formSlot={draft ? <div className="cg-form">{children.fields}</div> : undefined}
      formNote="Use the form above to change these values."
    />
  );
  return (
    <Modal title={draft ? `Set up ${channel.name}` : `Edit ${channel.name}`} sub={draft ? 'step 2 of 2 · draft' : 'secrets are write-only'} onClose={onClose} maxWidth={760} footer={footer}>
      <form id="channel-form" noValidate style={{ display: 'grid', gap: 14 }} onSubmit={(e) => (e.preventDefault(), onSubmit())}>
        {children.banners}
        {draft ? (
          <p className="cg-status mono-sm" role="note">
            {stillNeeded.length
              ? `Draft · receives nothing yet. Still needed before it can be activated: ${stillNeeded.join(', ')}.`
              : 'Draft · credentials saved. Test the connection, then activate the channel from its card (a second person approves).'}
          </p>
        ) : null}
        {url ? <WebhookUrlRow url={url} /> : null}
        <GeneratedSecrets secrets={generated.filter((g) => !children.pendingKeys.includes(g.label))} />
        {draft ? (
          guide
        ) : (
          <>
            {children.fields}
            <details className="conn-fieldset cg-guide-details">
              <summary className="legend">Setup guide · {kind.setupGuide.length} steps</summary>
              {guide}
            </details>
          </>
        )}
        {kind.connectionCheck ? <ChannelTest channelId={channel.id} onHelp={trouble.show} helpIds={kind.troubleshooting.map((t) => t.id)} /> : null}
        <Troubleshooting entries={kind.troubleshooting} open={trouble.open} onToggle={trouble.setOpen} />
      </form>
    </Modal>
  );
}

/** The channel dialog's error and info banners (and the approval submit modal). */
export function DialogBanners({ error, info, modal }: { error: string | null | undefined; info: ReadonlyArray<string | null | undefined>; modal: ReactNode }) {
  return (
    <>
      {error ? (
        <AlertBanner tone="error" style={{ margin: 0 }}>
          {error}
        </AlertBanner>
      ) : null}
      {info.filter(Boolean).map((text) => (
        <AlertBanner key={text} tone="info" style={{ margin: 0 }}>
          {text}
        </AlertBanner>
      ))}
      {modal}
    </>
  );
}
