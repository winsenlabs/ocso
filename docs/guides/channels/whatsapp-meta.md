# WhatsApp through Meta Cloud API

This guide connects a WhatsApp Business number that is registered directly with Meta (no Twilio) to OCSO, as
the `WHATSAPP` channel kind (label **WhatsApp — Meta Cloud API**). OCSO calls the Cloud API to send, and Meta posts
incoming messages, delivery statuses and template review results to the channel's webhook. It is for the Tech admin
who sets the channel up. If your number is on Twilio, use [WhatsApp through Twilio](whatsapp-twilio.md) instead.

The adapter is in [packages/channels/src/whatsapp/](../../../packages/channels/src/whatsapp/). Its provider details
(normalization, media, error codes) are in [packages/channels/README.md](../../../packages/channels/README.md#whatsapp).

> [!WARNING]
> This adapter is tested offline against Meta-shaped fixtures only. It has not been run against a live WhatsApp
> Business number. Work through the
> [live verification checklist](../../../packages/channels/README.md#needs-live-verification) before customers use it.

## Prerequisites

At Meta:

- A Meta **Business** app with the **WhatsApp** product, and a business phone number added and registered to a
  WhatsApp Business Account (WABA).
- A **system user** (Business Settings → Users → System users) assigned to the app and the WABA, with a
  **permanent** token that has `whatsapp_business_messaging` (sending) and `whatsapp_business_management` (message
  templates). Do not use the 24-hour temporary token from the API Setup page in production.
- The app is subscribed to the WABA. The dashboard's setup flow does this; otherwise call
  `POST /{WABA_ID}/subscribed_apps` with the system-user token.

In OCSO:

- `OCSO_PUBLIC_URL` is an https origin Meta can reach. The webhook URL is built from it.
- With the default `outboundMediaMode` of `link`, Meta downloads outbound media from a short-lived signed blob URL,
  so blob storage must be reachable from the internet. Otherwise set `outboundMediaMode` to `upload`.
- A Tech admin (`channels.manage`) to create the channel, and a Head (`approvals.check.channels`) to approve it.

## Values you need

| Where in Meta | OCSO field | Key |
|---|---|---|
| WhatsApp → API Setup: **Phone number ID** (not the phone number) | Phone number id | `settings.phoneNumberId` |
| WhatsApp Manager → Account tools: WABA id | WhatsApp Business Account id | `settings.businessAccountId` (optional; needed for templates) |
| The system-user token | Access token | `secrets.accessToken` |
| App settings → Basic → **App secret** | App secret | `secrets.appSecret` |
| Any random string, 16 or more characters, no whitespace | Webhook verify token | `secrets.verifyToken` (**Generate** makes one) |

## Set it up

1. **Create the draft.** In OCSO open **Integrations → Channels → Add channel**, choose **WhatsApp — Meta Cloud
   API**, enter a **Name** and choose **Create draft and continue**. The guide opens with the channel's webhook URL:

   ```text
   https://<your OCSO host>/channels/whatsapp/<publicKey>/webhook
   ```

2. **Save the channel in OCSO.** In the guide's first step, enter the phone number id, the access token, the app
   secret and a webhook verify token (**Generate** makes a random one; copy it now), and the WABA id if you want
   message templates. Save.
3. **Point Meta's webhook at OCSO.** In the Meta app dashboard open **WhatsApp → Configuration → Webhook** and choose
   **Edit**. Paste the webhook URL as the **Callback URL** and the same verify token, then **Verify and save**. OCSO
   answers Meta's `GET` challenge (`hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`) for this channel only.
   Check: Meta accepts the Callback URL without an error.
4. **Subscribe to the webhook fields.** Under **Webhook fields** subscribe to:
   - `messages`: incoming messages and delivery statuses;
   - `message_template_status_update`: template review results;
   - `user_id_update` (recommended): business-scoped user id changes, which OCSO applies to the existing customer
     instead of creating a new one. The in-app guide does not list this field, but the adapter parses it.
5. **Message templates (optional).** Templates are the only way to reach a customer 24 hours after their last
   message. Set **WhatsApp Business Account id** on the channel; the access token needs
   `whatsapp_business_management`. See [Message templates](#message-templates-and-the-24-hour-window).
6. **Activate.** Choose **Activate** on the channel card. A Head approves it under **Approvals**.
7. **Attach it to a router** under **Routers** (see [Channels](README.md#5-attach-it-to-a-router)).

There is no **Test connection** for this kind: the adapter does not implement a connection check. The first real
message is the test.

## Settings

| Setting (form label) | Default | Meaning |
|---|---|---|
| `phoneNumberId` (Phone number id) | required | Default sending number. An inbound message's own `phone_number_id` is used for replies, so one channel can serve several numbers of one WABA. Numeric. |
| `businessAccountId` (WhatsApp Business Account id) | none | Needed to list, create and track message templates. When set, webhook entries for other WABAs are ignored. Numeric. |
| `graphApiVersion` | `v26.0` | Graph API version. Pin it and upgrade deliberately; Meta retires versions about two years after release. |
| `graphBaseUrl` | `https://graph.facebook.com` | Override only for tests or a proxy. https required (http only on localhost). |
| `outboundMediaMode` | `link` | `link`: Meta fetches a short-lived signed blob URL. `upload`: OCSO uploads the bytes to `/{phone-number-id}/media` first. |
| `mediaLinkTtlSeconds` | `900` | Lifetime of signed links in `link` mode (60 to 86,400). |
| `requestTimeoutMs` | `15000` | One Graph call. |
| `mediaDownloadTimeoutMs` | `60000` | One inbound media download. |

Secrets: `accessToken`, `appSecret` and `verifyToken`, all required, no whitespace. The channel card shows the
phone number id as its identity.

## How it behaves

- **Verification.** Every `POST` must carry `X-Hub-Signature-256`, an HMAC-SHA256 of the raw body with the app
  secret, compared in constant time. A missing header gets `401`, a wrong one `403`.
- **Identity.** Meta's business-scoped user id (BSUID) is the primary identity (`whatsapp_bsuid`); the phone number
  in E.164 is kept as an alternate (`whatsapp_phone`).
- **Inbound.** Text, images and stickers, audio and voice notes, video, documents, locations, contacts, button and
  list replies, reactions and click-to-WhatsApp referrals. Orders and unsupported types are counted as ignored.
  Media is downloaded by the worker from Meta's CDN hosts only, size- and type-checked, and stored in blob storage.
- **Outbound.** Markdown becomes WhatsApp formatting (`*bold*`, `_italic_`, `~strike~`, links as `text (url)`),
  chunked at 4,096 characters. Images must be JPEG or PNG. Captions up to 1,024 characters.
- **Limits per media kind.** Images 5 MB, audio 16 MB, video 16 MB, documents 100 MB.

### Choice questions

A router's choice question is sent natively:

| Options | Rendered as |
|---|---|
| 1 to 3 | interactive reply buttons (titles cut to 20 characters) |
| 4 to 10 | an interactive list message; its opening button reads "Choose" (rows cut to 24 characters) |
| more than 10, or cut titles that would collide | the numbered text |

A tap comes back as a `button_reply` or `list_reply` with the option id. Typed answers ("2", "Loans") work too.

## Message templates and the 24-hour window

WhatsApp only accepts free-form messages within 24 hours of the customer's last message. After that, only
approved templates go through.

- The conversation shows whether the window is open. A person's free-form reply after it closes is refused with
  `409 session_window_closed` before anything is sent. The composer's **Template** mode sends an approved template
  instead.
- A reply already queued that Meta refuses with code 131047 is marked failed with the same code.
- A router question outside the window uses the approved template mapped for this channel in the router, if any.

Creating a template:

1. Set `businessAccountId` on the channel (without it the template list reports `templates_not_configured`).
2. Open **Integrations → Message templates** (or **Templates** on the channel card) and choose **New template**.
3. Fill in the builder and choose **Save and submit for approval** (or **Save draft** and submit later). Variables are
   numbered per component (`body.1`, `header.1`).
4. A Head approves the submission (`approvals.check.channels`). Only then does the worker send it to Meta, once.
5. Meta reviews it (usually minutes, up to 24 hours). OCSO learns the result from the
   `message_template_status_update` webhook and also polls templates in review every 3 minutes. The submitter
   gets an in-app notice.

Templates with a media header need an uploaded sample, which OCSO cannot create on Meta: create those in WhatsApp
Manager. They then appear in OCSO's list. Only `APPROVED` templates are sendable. Deleting a template needs
`message_templates.delete` (Head) and is a proposal.

## Verify it works

1. Send a WhatsApp message to the business number from a phone.
2. The channel card shows "last inbound … ago", and the conversation appears in the inbox with the `WA` badge.
3. The agent's reply arrives on the phone, and its delivery status moves to delivered and read.
4. Reply after 24 hours with a template to check the template path.

## Troubleshooting

| Problem | Fix |
|---|---|
| Meta says the callback URL or verify token could not be validated | Save the channel first, then paste exactly the same verify token in Meta. The Callback URL must be the https webhook URL OCSO shows, on an `OCSO_PUBLIC_URL` Meta can reach. |
| Messages never arrive although the webhook verified | OCSO checks every delivery with the app secret. Paste the **App secret** of the same Meta app whose webhook you configured, and check that the `messages` field is subscribed. |
| Messages arrive but are rejected with `no_router` | Attach the channel to an active router. |
| Outbound media fails in `link` mode | Blob storage is not reachable from Meta. Make it reachable or set `outboundMediaMode` to `upload`. |
| Replies fail with `auth_failed` (Meta code 190) | The access token expired or was revoked. Use a permanent system-user token. On a live channel the change is a proposal. |
| Replies fail with `session_window_closed` | The 24-hour window closed. Send an approved template. |
| The template list says templates are not configured | Set **WhatsApp Business Account id** and give the token `whatsapp_business_management`. |

## Limits and known gaps

- Not verified against a live number (see the warning above), including real signature checks, BSUID payloads,
  CDN hostnames and error payloads.
- No **Test connection**.
- Templates with media headers must be created in WhatsApp Manager.
- Sends are at-least-once: Meta has no idempotency key, so a crash between Meta accepting a message and OCSO
  recording its id can deliver a duplicate.
- Inbound documents outside Meta's MIME list (for example `.csv`) are rejected.

## Related

- [Channels overview](README.md)
- [WhatsApp through Twilio](whatsapp-twilio.md)
- [Routing](../../concepts/routing.md)
- [Governance and approvals](../../concepts/governance.md)
- [packages/channels/README.md](../../../packages/channels/README.md#whatsapp): adapter internals and error mapping
