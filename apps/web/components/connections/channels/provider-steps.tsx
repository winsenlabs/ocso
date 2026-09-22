/** Provider-console steps after saving a webhook channel: where to paste the URL for each WhatsApp integration. */
export function ProviderSteps({ kind, verifyToken }: { kind: string; verifyToken?: string | undefined }) {
  if (kind === 'TWILIO_WHATSAPP') {
    return (
      <ol className="setup-steps">
        <li>
          In the Twilio Console open Messaging → Senders → WhatsApp senders and edit your sender (sending through a Messaging Service: its Integration settings; testing with
          the Sandbox: WhatsApp sandbox settings).
        </li>
        <li>Paste the URL above as the webhook for incoming messages, method HTTP POST, exactly as shown (no trailing slash) — Twilio signs that exact URL.</li>
        <li>Paste the same URL as the status callback URL so delivered / read / failed statuses reach OCSO.</li>
        <li>
          Outside the 24-hour customer window WhatsApp only accepts approved templates. Create them in OCSO under WhatsApp templates (or in Twilio’s Content Template Builder);
          OCSO lists them with the same credentials and execs send them from the conversation.
        </li>
        <li>Send a test message to your WhatsApp number; the channel card shows the last inbound time.</li>
      </ol>
    );
  }
  if (kind === 'WHATSAPP') {
    return (
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
        <li>Subscribe the webhook to the messages field (it carries delivery statuses too) and to message_template_status_update (template review results).</li>
        <li>
          For message templates (the only way to reach a customer 24 hours after their last message) set the WhatsApp Business Account id on this channel; the access
          token needs whatsapp_business_management.
        </li>
        <li>Send a test message to the business number; the channel card shows the last inbound time.</li>
      </ol>
    );
  }
  return <p className="mono-sm">Configure the provider to call this URL for inbound messages; requests are verified before anything is stored.</p>;
}
