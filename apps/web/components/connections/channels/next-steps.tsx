'use client';

import { CopyButton } from '../copy-button';
import { embedSnippet, inboundWebhookUrl } from './settings-form';

interface Props {
  channel: { kind: string; publicKey: string; webhookPath: string | null; status: string };
  kind: { inboundWebhook: boolean; embeddable: boolean; label: string };
  publicOrigin: string;
  /** Verify token generated in this dialog (shown once), if any. */
  verifyToken?: string | undefined;
  allowedOrigins: string[];
}

/** What the admin does next: point the provider at the webhook, or embed the widget. */
export function ChannelNextSteps({ channel, kind, publicOrigin, verifyToken, allowedOrigins }: Props) {
  const inactive = channel.status !== 'ACTIVE' ? <p className="mono-sm">The channel is {channel.status.toLowerCase()}: set it to Active before customers use it.</p> : null;
  if (kind.inboundWebhook) {
    const url = inboundWebhookUrl(publicOrigin, channel);
    return (
      <section className="conn-fieldset" aria-label="Connect the provider">
        <span className="legend">Next · connect {kind.label}</span>
        <div className="rowsplit" style={{ flexWrap: 'nowrap' }}>
          <code className="secret-once" aria-label="Webhook URL">
            {url}
          </code>
          <CopyButton value={url} what="webhook URL" />
        </div>
        {channel.kind === 'WHATSAPP' ? (
          <ol className="setup-steps">
            <li>In the Meta app dashboard open WhatsApp → Configuration → Webhook and choose Edit.</li>
            <li>Paste the webhook URL above as the Callback URL.</li>
            <li>
              Enter the same webhook verify token you saved on this channel
              {verifyToken ? (
                <>
                  {' '}
                  (<code className="mono">{verifyToken}</code>, shown only now)
                </>
              ) : null}
              , then Verify and save — OCSO answers Meta’s challenge.
            </li>
            <li>Subscribe the webhook to the messages field (it carries delivery statuses too).</li>
            <li>Send a test message to the business number; the channel card shows the last inbound time.</li>
          </ol>
        ) : (
          <p className="mono-sm">Configure the provider to call this URL for inbound messages; requests are verified before anything is stored.</p>
        )}
        {inactive}
      </section>
    );
  }
  if (kind.embeddable) {
    const snippet = embedSnippet(publicOrigin, channel.publicKey);
    return (
      <section className="conn-fieldset" aria-label="Embed the widget">
        <span className="legend">Next · embed the widget</span>
        <p style={{ margin: 0, fontSize: 12.5 }}>Add this tag to every page that should show the chat launcher:</p>
        <div className="rowsplit" style={{ flexWrap: 'nowrap' }}>
          <code className="secret-once" aria-label="Embed snippet">
            {snippet}
          </code>
          <CopyButton value={snippet} what="embed snippet" />
        </div>
        <p className="mono-sm">
          {allowedOrigins.length
            ? `Only ${allowedOrigins.join(', ')} may embed it (Allowed origins). Add every site that uses the widget.`
            : 'Allowed origins is empty, so any site may embed the widget. Add your site origins to restrict it.'}
        </p>
        {inactive}
      </section>
    );
  }
  return inactive;
}
