'use client';

import { CopyButton } from '../copy-button';
import { ChannelTest } from './channel-test';
import { EmbedPanel } from './embed-panel';
import { GeneratedSecrets, ProviderSteps } from './provider-steps';
import { inboundWebhookUrl } from './settings-form';

interface Props {
  channel: { id: string; kind: string; publicKey: string; webhookPath: string | null; status: string };
  /** From the kind's descriptor (GET /v1/channels/kinds). */
  kind: { inboundWebhook: boolean; embeddable: boolean; label: string; connectionCheck: boolean; setupSteps: readonly string[] };
  publicOrigin: string;
  /** Secrets generated in this dialog for the admin to copy elsewhere (shown once), if any. */
  generated?: ReadonlyArray<{ label: string; value: string }> | undefined;
  allowedOrigins: string[];
  /** The kind's auth mode setting when it has one (embeddable kinds): snippets fetch a session pass unless anonymous. */
  authMode?: string | undefined;
}

/** What the admin does next: point the provider at the webhook (and test the credentials), or embed the widget. */
export function ChannelNextSteps({ channel, kind, publicOrigin, generated = [], allowedOrigins, authMode = 'anonymous' }: Props) {
  const inactive = channel.status !== 'ACTIVE' ? <p className="mono-sm">The channel is {channel.status.toLowerCase()}: set it to Active before customers use it.</p> : null;
  const url = kind.inboundWebhook ? inboundWebhookUrl(publicOrigin, channel) : null;
  if (url) {
    return (
      <>
        <section className="conn-fieldset" aria-label="Connect the provider">
          <span className="legend">Next · connect {kind.label}</span>
          <div className="rowsplit" style={{ flexWrap: 'nowrap' }}>
            <code className="secret-once" aria-label="Webhook URL">
              {url}
            </code>
            <CopyButton value={url} what="webhook URL" />
          </div>
          <ProviderSteps steps={kind.setupSteps} fallback="Configure the provider to call this URL for inbound messages; requests are verified before anything is stored." />
          <GeneratedSecrets secrets={generated} />
          {inactive}
        </section>
        {kind.connectionCheck ? <ChannelTest channelId={channel.id} /> : null}
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
        {kind.setupSteps.length ? <ProviderSteps steps={kind.setupSteps} fallback="" /> : null}
        <GeneratedSecrets secrets={generated} />
        {inactive}
      </section>
    );
  }
  return inactive;
}
