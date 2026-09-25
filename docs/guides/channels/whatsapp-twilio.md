# WhatsApp through Twilio

This guide connects a WhatsApp sender on Twilio to OCSO, as the `TWILIO_WHATSAPP` channel kind (label **WhatsApp —
Twilio**). OCSO sends through Twilio's Messaging API, and Twilio posts incoming messages and delivery statuses to
the channel's webhook. It is for the Tech admin who sets the channel up. Twilio is listed first in **Add channel**:
it is OCSO's primary WhatsApp path. If your number is registered directly with Meta, use
[WhatsApp through Meta Cloud API](whatsapp-meta.md).

The adapter is in [packages/channels/src/twilio-whatsapp/](../../../packages/channels/src/twilio-whatsapp/).

> [!WARNING]
> This adapter is tested offline, against Twilio-shaped fixtures and a local Twilio stub
> (`apps/api/test/int/twilio-whatsapp.int.test.ts`). It has not been run against a live Twilio account. Open
> questions (media redirect hosts, sends to a BSUID, list-picker reply parameters, Twilio's webhook timeout) are in
> the [live verification checklist](../../../packages/channels/README.md#needs-live-verification).

## Prerequisites

At Twilio:

- A Twilio account with a WhatsApp sender: an approved WhatsApp sender, a Messaging Service whose sender pool holds
  it, or the WhatsApp Sandbox for testing.
- The **Account SID** (starts with `AC`) and the **Auth token** (Twilio Console → Account info). Twilio signs every
  webhook with the account's primary auth token, so OCSO needs it even if you send with an API key.
- Optional: an API key (`SK…`) and its secret, to send and download media with the key instead of the auth token.

In OCSO:

- `OCSO_PUBLIC_URL` is an https origin Twilio can reach. Twilio signs the exact URL it calls, and OCSO rebuilds that
  URL from `OCSO_PUBLIC_URL` to check the signature.
- A Tech admin (`channels.manage`) and a Head (`approvals.check.channels`).

## Values you need

| Where in Twilio | OCSO field | Key |
|---|---|---|
| Account info: Account SID | Account SID | `settings.accountSid` |
| Your sender, e.g. `whatsapp:+14155238886` | WhatsApp sender | `settings.from` |
| or a Messaging Service (`MG…`) | Messaging Service SID | `settings.messagingServiceSid` |
| Account info: Auth token | Auth token | `secrets.authToken` (required) |
| Optional API key SID (`SK…`) | API key SID | `settings.apiKeySid` |
| Its secret | API key secret | `secrets.apiKeySecret` (required when `apiKeySid` is set) |

Set exactly one of **WhatsApp sender** and **Messaging Service SID**.

## Set it up

1. **Create the draft.** Open **Integrations → Channels → Add channel**, choose **WhatsApp — Twilio**, enter a
   **Name** and choose **Create draft and continue**. The guide shows the webhook URL:

   ```text
   https://<your OCSO host>/channels/twilio-whatsapp/<publicKey>/webhook
   ```

2. **Save the channel in OCSO.** Enter the Account SID, the WhatsApp sender (or Messaging Service SID) and the auth
   token in the guide's form step. If you send with an API key, add its SID in the settings and its secret. Save.
3. **Point your WhatsApp sender at OCSO.** In the Twilio Console open **Messaging → Senders → WhatsApp senders** and
   edit your sender. For a Messaging Service use its **Integration** settings; for the Sandbox use **WhatsApp sandbox
   settings**. Paste the webhook URL for incoming messages, method **HTTP POST**, exactly as shown: no trailing
   slash, no extra query.
4. **Set the status callback.** Paste the same URL as the status callback URL, so delivered, read and failed statuses
   reach OCSO. With **Request delivery statuses** on (the default) OCSO also asks for statuses per message, which
   needs an https `OCSO_PUBLIC_URL`.
5. **Message templates.** Outside the 24-hour window WhatsApp only accepts approved templates. Create them in OCSO
   (below) or in Twilio's Content Template Builder; OCSO lists both with the same credentials.
6. **Test connection.** Choose **Test connection**. It fetches the account (`GET /Accounts/{sid}.json`) and never
   sends a message. It reports:
   - **Account SID + auth token** (or **API key**): the account is active;
   - **Auth token (signs webhooks)**, when you use an API key: the token is valid, so webhook signatures can be
     checked;
   - **Delivery statuses**: requested per message, or a note that `OCSO_PUBLIC_URL` must be https.

   The sender itself is only checked by Twilio at send time (error 63007).
7. **Activate** the channel. A Head approves it under **Approvals**.
8. **Attach it to a router** under **Routers**.

## Settings

| Setting (form label) | Default | Meaning |
|---|---|---|
| `accountSid` (Account SID) | required | `AC` + 32 hex characters. |
| `from` (WhatsApp sender) | none | `whatsapp:+14155238886`. Leave empty when sending through a Messaging Service. |
| `messagingServiceSid` (Messaging Service SID) | none | `MG` + 32 hex characters. |
| `apiKeySid` (API key SID) | none | `SK` + 32 hex characters; then `apiKeySecret` is required. |
| `statusCallback` (Request delivery statuses) | `true` | Ask Twilio to post each message's status to this channel's webhook. |
| `apiBaseUrl` (API base URL) | `https://api.twilio.com` | Override only for tests or an egress proxy. |
| `contentApiBaseUrl` (Content API base URL) | `https://content.twilio.com` | Templates. Override only for tests or a proxy. |
| `mediaLinkTtlSeconds` | `900` | Lifetime of the signed blob URL Twilio downloads outbound media from. |
| `requestTimeoutMs` | `15000` | One Twilio call. |
| `mediaDownloadTimeoutMs` | `60000` | One inbound media download. |

Secrets are at least 16 characters, without whitespace. The channel card shows the sender (or Messaging Service) as
its identity.

## How it behaves

- **Verification.** `X-Twilio-Signature` is an HMAC-SHA1 over the URL Twilio called plus the sorted form parameters.
  OCSO rebuilds the URL from `OCSO_PUBLIC_URL`'s origin and the path and query as received, and accepts it with or
  without the port, as `twilio-node` does. OCSO answers with empty TwiML.
- **One URL** takes inbound messages and status callbacks. Messages are idempotent on `MessageSid`; statuses never
  move backwards.
- **Identity.** The phone number (`whatsapp_phone`, E.164). Twilio's `ExternalUserId` (BSUID) is kept as an alternate
  and used only when no phone is known.
- **Inbound.** Text, images, audio, video, documents, locations, quick-reply buttons (`ButtonPayload`), flows and
  referrals. Shared contacts arrive as `text/vcard` documents. SMS and other accounts are ignored.
- **Outbound.** WhatsApp formatting, chunked at 1,600 characters (Twilio's body limit). One media item per message,
  sent as a short-lived signed blob URL; captions only on images, so other media is followed by its caption as a
  separate text message. Images must be JPEG or PNG, up to 5 MB; audio and video up to 16 MB; documents up to 20 MB.

### Choice questions

Twilio needs a Content Template for interactive buttons, so a router's choice question is sent as its **numbered
text**. Customers answer with the number or the label.

## Message templates and the 24-hour window

- A free-form reply after the window closes is refused with `409 session_window_closed`; use the composer's
  **Template** mode. A queued reply Twilio refuses with 63016 is marked failed with the same code.
- Templates use the Twilio **Content API** with the channel's credentials. Variables are numbered across the whole
  template (`1`, `2`).
- **New template** under **Integrations → Message templates** saves a draft in OCSO; **Save and submit for approval**
  sends it to a Head (`approvals.check.channels`). After approval the worker creates the content and submits it for
  WhatsApp approval (`ApprovalRequests/whatsapp`), once.
- OCSO polls templates in review every 3 minutes and notifies the submitter. Twilio has no template webhook here.
- Only `APPROVED` templates are sendable; they go out as `ContentSid` + `ContentVariables`.

## Verify it works

1. Send a WhatsApp message to your sender (for the Sandbox, join it first with its code).
2. The channel card shows "last inbound … ago"; the conversation appears with the `WA` badge.
3. The reply arrives, and its status moves to delivered and read.

## Troubleshooting

| Problem | Fix |
|---|---|
| Twilio's requests are refused (403) or messages never arrive | Twilio signs the exact URL it calls: paste the webhook URL exactly as shown (https, no trailing slash, no extra query). The auth token must be the account's current primary token, even when you send with an API key. |
| Test connection: "Twilio rejected the credentials (HTTP 401)" | Check the Account SID and auth token (or the API key SID and secret). |
| Test connection: "Delivery statuses … need an https public URL" | Set `OCSO_PUBLIC_URL` to https, or turn off **Request delivery statuses** and set the status callback in Twilio. |
| Sends fail with `invalid_sender` (63007) | The sender is not a WhatsApp sender on this account, or the Messaging Service has none. |
| Sends fail with `session_window_closed` (63016) | The 24-hour window closed. Send an approved template. |
| Sends fail with `recipient_opted_out` (21610) | The customer opted out. |
| Messages arrive but are rejected with `no_router` | Attach the channel to an active router. |

## Limits and known gaps

- Not verified against a live Twilio account.
- Choice questions are numbered text, not buttons.
- One media item per message; captions on images only.
- Sends are at-least-once.

## Related

- [Channels overview](README.md)
- [WhatsApp through Meta Cloud API](whatsapp-meta.md)
- [Routing](../../concepts/routing.md)
- [Governance and approvals](../../concepts/governance.md)
- [packages/channels/README.md](../../../packages/channels/README.md): adapter internals and error mapping
