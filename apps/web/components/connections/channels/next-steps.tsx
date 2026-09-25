'use client';

import { useCallback, useState } from 'react';
import type { SetupStep } from '@/lib/api/channels';
import { CopyButton } from '../copy-button';
import { ChannelTest } from './channel-test';
import { EmbedPanel } from './embed-panel';
import { GeneratedSecrets } from './provider-steps';
import type { SetupFileDef } from './settings-form';
import { inboundWebhookUrl } from './settings-form';
import { SetupGuide, Troubleshooting } from './setup-guide';

export interface KindGuideInfo {
  inboundWebhook: boolean;
  embeddable: boolean;
  label: string;
  connectionCheck: boolean;
  setupGuide: readonly SetupStep[];
  troubleshooting: ReadonlyArray<{ id: string; problem: string; fix: string }>;
  setupFiles?: readonly SetupFileDef[] | undefined;
}

interface Props {
  channel: { id: string; kind: string; publicKey: string; webhookPath: string | null; status: string; settings?: Record<string, unknown> | undefined };
  /** From the kind's descriptor (GET /v1/channels/kinds). */
  kind: KindGuideInfo;
  publicOrigin: string;
  /** Secrets generated in this dialog for the admin to copy elsewhere (shown once), if any. */
  generated?: ReadonlyArray<{ label: string; value: string }> | undefined;
  allowedOrigins: string[];
  /** The kind's auth mode setting when it has one (embeddable kinds): snippets fetch a session pass unless anonymous. */
  authMode?: string | undefined;
}

/** Opens the troubleshooting list and scrolls to one entry (a connection check's "How to fix"). */
export function useTroubleshooting(): { open: boolean; setOpen: (open: boolean) => void; show: (id: string) => void } {
  const [open, setOpen] = useState(false);
  const show = useCallback((id: string) => {
    setOpen(true);
    requestAnimationFrame(() => {
      const el = document.getElementById(`ts-${id}`);
      el?.scrollIntoView({ block: 'center' });
      el?.focus();
    });
  }, []);
  return { open, setOpen, show };
}

/** The webhook URL the provider calls, with Copy. */
export function WebhookUrlRow({ url }: { url: string }) {
  return (
    <div className="cg-webhook">
      <span className="mono-sm">Webhook URL · the provider calls this</span>
      <div className="rowsplit" style={{ flexWrap: 'nowrap' }}>
        <code className="secret-once" aria-label="Webhook URL">
          {url}
        </code>
        <CopyButton value={url} what="webhook URL" />
      </div>
    </div>
  );
}

/** What the admin does next after saving: the kind's guide with this channel's values, the connection test, or the embed snippets. */
export function ChannelNextSteps({ channel, kind, publicOrigin, generated = [], allowedOrigins, authMode = 'anonymous' }: Props) {
  const trouble = useTroubleshooting();
  const inactive = channel.status !== 'ACTIVE' ? <p className="mono-sm">The channel is {channel.status.toLowerCase()}: activate it (a second person approves) before customers use it.</p> : null;
  const url = kind.inboundWebhook ? inboundWebhookUrl(publicOrigin, channel) : null;
  const ctx = { webhookUrl: url, settings: channel.settings ?? {} };
  if (url) {
    return (
      <>
        <section className="conn-fieldset" aria-label="Connect the provider">
          <span className="legend">Next · connect {kind.label}</span>
          <WebhookUrlRow url={url} />
          {kind.setupGuide.length ? (
            <SetupGuide steps={kind.setupGuide} files={kind.setupFiles ?? []} ctx={ctx} channelId={channel.id} label={kind.label} formNote="Done: the values are saved on this channel." />
          ) : (
            <p className="mono-sm">Configure the provider to call this URL for inbound messages; requests are verified before anything is stored.</p>
          )}
          <GeneratedSecrets secrets={generated} />
          {inactive}
        </section>
        {kind.connectionCheck ? <ChannelTest channelId={channel.id} onHelp={trouble.show} helpIds={kind.troubleshooting.map((t) => t.id)} /> : null}
        <Troubleshooting entries={kind.troubleshooting} open={trouble.open} onToggle={trouble.setOpen} />
      </>
    );
  }
  if (kind.embeddable) {
    return (
      <section className="conn-fieldset" aria-label="Embed the widget">
        <span className="legend">Next · embed the widget</span>
        <EmbedPanel target={{ origin: publicOrigin, publishableKey: channel.publicKey, authMode }} idBase={`embed-${channel.id}`} />
        <p className="mono-sm">
          {allowedOrigins.length
            ? `Only ${allowedOrigins.join(', ')} may embed it (Allowed origins). Add every site that uses the widget.`
            : 'Allowed origins is empty, so any site may embed the widget. Add your site origins to restrict it.'}
        </p>
        <SetupGuide steps={kind.setupGuide} files={kind.setupFiles ?? []} ctx={ctx} channelId={channel.id} label={kind.label} formNote="Done: the channel is saved." />
        <GeneratedSecrets secrets={generated} />
        {inactive}
      </section>
    );
  }
  return inactive;
}
