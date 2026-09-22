# 06: WhatsApp via Twilio

Researched 2026-09-22. **Method:** WebSearch to locate current twilio.com/docs pages, then WebFetch of the primary Twilio docs pages themselves (not just search snippets) for `messaging/guides/webhook-request`, `usage/webhooks/webhooks-security`, `messaging/guides/track-outbound-message-status`, `messaging/guides/outbound-message-status-in-status-callbacks`, `messaging/api/message-resource`, `messaging/api/media-resource`, `whatsapp/api`, `whatsapp/sandbox`, `whatsapp/buttons`, `whatsapp/message-features`, `whatsapp/guidance-whatsapp-media-messages`, `whatsapp/api/error-code-mapping`, `messaging/guides/accepted-mime-types`, `content/content-api-resources`, ~20 individual `api/errors/<code>` pages, and several `en-us/changelog/*` entries. For the signature algorithm I fetched the actual `twilio-node` source from `raw.githubusercontent.com/twilio/twilio-node/main/src/webhooks/webhooks.ts` and quote it directly (marked `VERIFIED(code)`). `support.twilio.com`/`help.twilio.com` articles returned 403/empty to WebFetch (JS-gated), so a few facts rest on WebSearch summaries of those pages only — those are marked UNVERIFIED with the caveat noted. Several `twilio.com/docs` pages themselves render thin (SPA) content to WebFetch's extractor and omitted tables the page visibly has in a browser (e.g. `webhook-request`'s `MessageType` question below) — where WebFetch came back empty on a specific fact after two tries, it's marked UNVERIFIED rather than assumed absent.

## TL;DR

- Inbound webhook is `application/x-www-form-urlencoded`. There is **no `MessageType` parameter** documented anywhere on `twilio.com/docs` (unlike Meta's Cloud API) — you infer message shape from `NumMedia`/`MediaContentType{N}`, `ButtonPayload`/`ButtonText`, `Latitude`/`Longitude`, etc. This is a real gap vs. the task's assumption; treat it as UNVERIFIED-as-absent, not a fetch failure.
- Signature validation is **HMAC-SHA1(AuthToken, url + sorted "key+value" params)**, base64-encoded. Confirmed straight from `twilio-node` source: `validateRequest` tries **four URL variants** (no-port, with `:443`/`:80` appended, and both again with a "legacy querystring" re-encoding) before failing. This four-way fallback is the single most implementation-relevant fact for a from-scratch adapter.
- Twilio added an **`ExternalUserId`** field to all message webhooks in 2026 to carry the WhatsApp BSUID — this is Twilio's answer to the BSUID/username rollout, distinct from Meta's own `user_id`/`from_user_id` fields used when calling Meta directly.
- Media download auth is now **on by default for new accounts** (rolling out through 2025–2026); the specific redirect-target hostnames (`mms.twiliocdn.com` / `s3-external-1.amazonaws.com`) could not be confirmed on a primary Twilio doc page — WebFetch to the relevant support article was blocked (403/empty). Recorded as UNVERIFIED, community-reported.
- `MessageStatus` enum has 13 documented values; `partially_delivered` is explicitly called out as **deprecated**.
- WhatsApp error codes cluster around 6300x (channel/session errors) and map 1:1 to a documented Meta error code table at `/docs/whatsapp/api/error-code-mapping`.

## 1. Inbound webhook — parameters

Content-Type is `application/x-www-form-urlencoded`. VERIFIED(doc: https://www.twilio.com/docs/messaging/guides/webhook-request).

**Core (all channels):**
| Param | Meaning |
|---|---|
| `MessageSid` | 34-char unique id (`SM`/`MM` + 32 hex) |
| `SmsSid`, `SmsMessageSid` | Same value as `MessageSid`; deprecated, kept for back-compat |
| `AccountSid` | Owning account |
| `MessagingServiceSid` | Present if the number is under a Messaging Service |
| `From` / `To` | `whatsapp:+E164` for WhatsApp |
| `Body` | Text, up to 1600 chars (Twilio's own cap — see §7) |
| `NumMedia`, `NumSegments` | Media count; segments always 1 for non-SMS/MMS |
| `MediaUrl{N}`, `MediaContentType{N}` | Zero-indexed |
All VERIFIED(doc: same URL).

**WhatsApp-specific**, added Feb 2021 per changelog: `ProfileName`, `WaId`, `Forwarded` (`"true"` if forwarded once), `FrequentlyForwarded` (`"true"` if forwarded many times). VERIFIED(doc: https://www.twilio.com/en-us/changelog/new-parameters-in-callbacks-for-inbound-whatsapp-messages) and VERIFIED(doc: https://www.twilio.com/docs/messaging/guides/webhook-request).

**Rich messaging:** `ButtonPayload` (postback id your app set), `ButtonText` (visible button text tapped), `ButtonType` (`REPLY` or `ACTION`), `InteractiveData` (JSON blob for omnichannel rich responses), `FlowData` (serialized WhatsApp Flow completion payload), `ChannelMetadata` (the full raw JSON Twilio received from the channel). VERIFIED(doc: webhook-request). For quick-reply buttons specifically: "you can get the text of the button tapped in the `ButtonText` parameter" and each button also carries an `id`. VERIFIED(doc: https://www.twilio.com/docs/whatsapp/buttons).
- **`ListId`/`ListTitle`/`ListItemId`:** not found on any fetched page (checked `webhook-request`, `whatsapp/buttons`; a dedicated `content/twilio-list-picker` URL 404'd). List-reply selections most likely surface inside `InteractiveData`/`ChannelMetadata` rather than as discrete top-level params. UNVERIFIED.

**Location:** `Latitude`, `Longitude`, `Address`, `Label`. Twilio explicitly notes "Locations do not appear in the Twilio Console" but are present in the webhook POST. VERIFIED(doc: webhook-request, https://www.twilio.com/docs/whatsapp/message-features).

**Reply/context:** `OriginalRepliedMessageSid`, `OriginalRepliedMessageSender` — "the SID/sender of the original message that this message is replying to," only populated for replies to messages sent within the last 7 days. VERIFIED(doc: webhook-request; corroborated by https://www.twilio.com/en-us/changelog/whatsapp-inbound-messages-will-now-include-reply-context).

**Click-to-WhatsApp ad referral:** `ReferralBody`, `ReferralHeadline`, `ReferralSourceId`, `ReferralSourceType`, `ReferralSourceUrl`, `ReferralMediaId`, `ReferralMediaContentType`, `ReferralMediaUrl`, `ReferralNumMedia`, `ReferralCtwaClid`. VERIFIED(doc: webhook-request).

**`MessageType`, `SmsStatus`, `ApiVersion`:** `MessageType` is not documented as a parameter anywhere I could find (checked `webhook-request` twice with targeted prompts, plus three WebSearches) — treat as **not sent**; UNVERIFIED-as-absent. `SmsStatus` is set to `"received"` on inbound webhooks (only surfaced via WebSearch summary of the page, not a direct quote — UNVERIFIED) and `ApiVersion` is consistently `2010-04-01` (same caveat — UNVERIFIED).

**Contacts/vCard:** Twilio does **not** deliver a structured `contacts` payload the way Meta's Cloud API does. A shared contact card arrives as ordinary **media** with MIME type `text/vcard` (`.vcf`), and "WhatsApp does not support including a text body in the same message as a contact (vCard) — if you pass `Body`... it will be ignored." VERIFIED(doc-adjacent via WebSearch of Twilio blog "How to Send a vCard with Twilio WhatsApp"; not independently confirmed on a docs.twilio.com page — UNVERIFIED but high-confidence).

**Sticker / voice content types:** Stickers are `image/webp` (webp is otherwise restricted to stickers only). Voice notes are `audio/ogg` (opus). Twilio does **not** appear to expose a discrete "this is a voice note vs. regular audio" boolean the way Meta's Cloud API does (`audio.voice:true`) — no such param found. VERIFIED(doc: https://www.twilio.com/docs/messaging/guides/accepted-mime-types) for MIME types; UNVERIFIED for absence of a voice-note flag.

**Reactions:** no reaction-specific inbound parameter name could be confirmed on any fetched Twilio page (`webhook-request`, `whatsapp/message-features`, changelog search). UNVERIFIED.

**BSUID / `ExternalUserId` (2026):** WhatsApp usernames roll out from June–July 2026, letting end users hide their phone number. Twilio's answer: a new Messaging API field, **`ExternalUserId`**, "included in all message webhooks, whether or not the user has adopted a username." Behavior: "If a phone number is present, `to`/`from` contain only the phone number, and `ExternalUserId` contains the BSUID. If no phone number is present, Twilio populates `to`, `from`, **and** `ExternalUserId` with the BSUID." BSUIDs began appearing in webhooks in early April 2026. VERIFIED(doc: https://www.twilio.com/en-us/changelog/whatsapp-usernames--new-business-scoped-user-id--bsuid--field-re). Implication for a channel adapter: key identity as `(phone_number_id-equivalent, ExternalUserId)`, not phone number alone, exactly as the sibling Meta-direct research file (`02-chat-sdk-and-whatsapp.md`) concluded for BSUID.

## 2. Expected response, retries, fallback

Twilio's own guidance: "return Twilio Markup Language (TwiML) as the response... for incoming messages without a reply, return an empty TwiML `<Response>` element." VERIFIED(doc: https://www.twilio.com/docs/usage/webhooks/messaging-webhooks). A bare empty 200 is the de facto no-op pattern in every Twilio quickstart (`<Response></Response>`), i.e. don't rely on returning nothing.

Timeout/retry specifics were **not found on any primary `twilio.com/docs` page** despite four targeted fetches (`webhooks-overview`, `webhooks-faq`, `getting-started-twilio-webhooks`, `api/errors/11200`). What is confirmed on a primary page: error **11200 ("HTTP Retrieval Failure")** documents that a non-2xx/timeout/unparseable response triggers this error, recommends responding "within a few seconds," and — for mitigation — "set a fallback URL on your Twilio phone number or TwiML app... so Twilio can retry on a different endpoint if your primary URL fails." VERIFIED(doc: https://www.twilio.com/docs/api/errors/11200). So: **a fallback URL mechanism exists and is documented**, but the exact timeout (commonly cited as 15s in third-party blogs) and whether incoming-message webhooks get any same-URL retry before falling back could not be confirmed on a Twilio-owned page — UNVERIFIED, and two different secondary sources disagreed with each other (one claimed no retry at all before fallback, another claimed status callbacks specifically get 3 retries with backoff — neither is a Twilio doc).

Whether Twilio follows HTTP redirects on a configured webhook URL: not documented anywhere found. UNVERIFIED.

## 3. Status callbacks

Configured via, in order of precedence: a per-message `StatusCallback` param overrides a Messaging-Service-level "Delivery Status Callback" set in Console, which itself is the fallback default. VERIFIED(doc: https://www.twilio.com/docs/messaging/guides/track-outbound-message-status): "If your Messaging Service has a service-level Delivery Status Callback configured in the Console and you provide a message-specific `StatusCallback` URL, Twilio sends status callback requests to the message-specific `StatusCallback` URL." For a standalone WhatsApp sender (no Messaging Service), the callback URL is set on the sender/sandbox config page directly (§9).

**Standard params (all messages):** `AccountSid`, `From`, `To`, `MessageSid`, `MessageStatus`, `SmsSid`, `SmsStatus`, `ErrorCode`. VERIFIED(doc: track-outbound-message-status).

**WhatsApp/omnichannel-specific:** `ChannelInstallSid` (the installed-channel SID that sent the message), `ChannelStatusMessage` (channel-specific error detail on failure), `ChannelPrefix`, `EventType` (e.g. `READ` for read receipts on supporting channels). VERIFIED(doc: track-outbound-message-status). `ChannelToAddress` also appears in this family per search-result excerpts but I could not get a direct quote defining it — UNVERIFIED.

**Full `MessageStatus` enum** (from the Message resource's `status` property table): `queued`, `sending`, `sent`, `failed`, `delivered`, `undelivered`, `receiving`, `received`, `accepted` (Messaging-Service-only initial state), `scheduled` (Messaging-Service-only), `canceled` (Messaging-Service-only), `read` (RCS and WhatsApp only — recipient opened the message), and **`partially_delivered`, explicitly marked deprecated**. VERIFIED(doc: https://www.twilio.com/docs/messaging/api/message-resource). `read` for WhatsApp/RCS is gated on the recipient having read receipts enabled. VERIFIED(doc: https://www.twilio.com/docs/messaging/guides/outbound-message-status-in-status-callbacks).

**Out-of-order arrival:** "there is no guarantee that the status callback requests always arrive at your endpoint in the order they were sent." VERIFIED(doc: track-outbound-message-status). Implication: store status as a monotonic max, same as the Meta-direct integration.

**Distinguishing an incoming message from a status callback:** the incoming-message webhook page's parameter table does not include `MessageStatus`; the status-callback page's table does. Practical rule: presence of `MessageStatus` ⇒ status callback; its absence with `SmsStatus` present (`"received"`) ⇒ inbound message. This is inferred by comparing the two fetched primary pages, not from an explicit "how to tell them apart" statement — treat the rule itself as UNVERIFIED even though each half is independently VERIFIED.

## 4. Request signature validation (`X-Twilio-Signature`)

Algorithm, quoted from the actual shipped source:

```ts
// getExpectedTwilioSignature
var data = Object.keys(params)
  .sort()
  .reduce((acc, key) => acc + toFormUrlEncodedParam(key, params[key]), url);
return crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");

// toFormUrlEncodedParam — repeated/array values are DEDUPED then sorted, then concatenated
function toFormUrlEncodedParam(paramName, paramValue) {
  if (paramValue instanceof Array) {
    return Array.from(new Set(paramValue)).sort()
      .map((val) => toFormUrlEncodedParam(paramName, val))
      .reduce((acc, val) => acc + val, "");
  }
  return paramName + paramValue;   // no delimiter between name and value, or between pairs
}
```
VERIFIED(code: https://github.com/twilio/twilio-node/blob/main/src/webhooks/webhooks.ts).

So: HMAC-SHA1 keyed with the account **Auth Token**, over `URL + Σ(sorted-by-key "name"+"value")`, base64-encoded — no separators anywhere. Repeated keys (array-valued params) are deduplicated by value and sorted before concatenation, not simply comma-joined or taken-first.

**Port and query-string handling** — `validateRequest` doesn't test one URL, it tries **four variants in order** and accepts if any matches:
```ts
removePort(urlObject)                              // 1
addPort(urlObject)                                  // 2: appends :443 (https) or :80 (http) if no explicit port
withLegacyQuerystring(removePort(urlObject))        // 3: re-encodes the query string with the legacy `querystring` module
withLegacyQuerystring(addPort(urlObject))           // 4
```
VERIFIED(code: same URL). `removePort`/`addPort` reconstruct the URL from its parsed parts (protocol, userinfo, host, pathname+search+hash) rather than string-splicing, so **path and query string are preserved exactly, including trailing slash** — there is no trailing-slash normalization in this code path; a trailing slash mismatch between the configured webhook URL and the URL Twilio actually requested will fail validation on all four variants. `withLegacyQuerystring` exists specifically because modern `URLSearchParams` encodes some characters (e.g. spaces, certain punctuation) differently than Node's legacy `querystring` module, and Twilio's signature was computed against the legacy encoding historically — so validators must try both to handle "special char encoding" drift.

**JSON body (`bodySHA256`):** for `application/json` webhooks, Twilio appends a `bodySHA256` query param containing a SHA-256 hex hash of the raw body; `validateRequestWithBody` calls `validateRequest(..., {})` (empty params, since JSON isn't form-encoded) **and separately** verifies the raw body's SHA-256 matches `bodySHA256`. VERIFIED(code: same URL; confirmed by doc: https://www.twilio.com/docs/usage/webhooks/webhooks-security).

**Which key signs:** the signature is always computed with the account's (primary) Auth Token as the HMAC key — "the key should be your account Auth Token, not an API key," even if the *outbound* API call that triggered the message was itself authenticated with an API Key SID/Secret. VERIFIED(doc: https://www.twilio.com/docs/usage/security, via WebSearch summary of the primary security page — direct WebFetch of that specific sentence not independently re-confirmed, so treat as high-confidence UNVERIFIED). What happens during **secondary Auth Token rotation** specifically for webhook signing is not documented on the secondary-auth-token API page (checked directly — no mention of webhook signing at all). UNVERIFIED; the safe assumption (not confirmed) is that a validator should try both primary and secondary tokens during the overlap window, mirroring why the secondary-token feature exists for REST auth.

## 5. Outbound Messages API

`POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json`, form-encoded. VERIFIED(doc: https://www.twilio.com/docs/messaging/api/message-resource).

Key params: `To` (required), `From` **or** `MessagingServiceSid` (one required), `Body`/`MediaUrl`/`ContentSid` (one required — for a Content Template, omit `Body`/`MediaUrl` entirely, since `ContentSid` replaces both), `StatusCallback`, `ContentVariables` (JSON string mapping template placeholder numbers to values, e.g. `{"1":"coupon_code","2":"docs"}` — "add `ContentSid` whenever you include `ContentVariables`"), `PersistentAction` (rich actions, e.g. WhatsApp location), `ProvideFeedback`, `ValidityPeriod` (max seconds queued, 1–36000). VERIFIED(doc: message-resource, https://www.twilio.com/docs/content/send-templates-created-with-the-content-template-builder, https://www.twilio.com/docs/content/using-variables-with-content-api).

**`MediaUrl` count:** the general Messages resource accepts "up to ten `media_url` parameters per message" (applies across SMS/MMS/other channels), but **WhatsApp free-form media messages honor only one** — "additional `MediaUrl` parameters will be ignored" — and WhatsApp disallows combining `Body` with video/audio/document/vCard/location media. VERIFIED(doc: message-resource; doc: https://www.twilio.com/docs/whatsapp/guidance-whatsapp-media-messages, via WebSearch summary of that page).

**Response JSON:** `sid` (`SM`/`MM` + 32 hex, regex `^(SM|MM)[0-9a-fA-F]{32}$`), `status`, `error_code`, `error_message`, `date_created`/`date_sent`/`date_updated`, `from`/`to`/`body`, `num_segments`, `price`/`price_unit`, `subresource_uris`. VERIFIED(doc: message-resource).

**Error codes and whether to retry** (all VERIFIED(doc: https://www.twilio.com/docs/api/errors/<code>) individually, plus the WhatsApp cross-reference table at https://www.twilio.com/docs/whatsapp/api/error-code-mapping):

| Code | Meaning | Retry? |
|---|---|---|
| 63016 | Outside the 24h session window for a freeform message; must use a Content Template | No — send via `ContentSid` instead |
| 63018 | Rate limit exceeded for channel/sender/account (WhatsApp default 80 msg/s) | Backoff + throttle, don't hot-retry |
| 63003 | Channel could not find `To` address (bad/unregistered/wrong-account address) | No |
| 63007 | Channel could not find a channel for the `From` address | No — fix sender config |
| 63001 | Channel authentication failed (credentials rejected by underlying provider) | No, until creds fixed |
| 63005 | Channel rejected content (check `ChannelStatusMessage` on the Message resource / StatusCallback) | No, until content fixed |
| 63019 | Media failed to download (0 bytes) | Sometimes — retry if transient network/URL blip, else fix file |
| 63021 | Channel invalid content (unsupported type / oversize per channel limits) | No |
| 63024 | Invalid message recipient (Meta flags recipient — not opted in / stale client) | Only after recipient remediates |
| 63025 | Media already exists (duplicate media-create) | No — reuse existing Media subresource |
| 63030 | Unsupported parameter for the channel/message type (e.g. `MediaUrl` with a Content Template) | No |
| 63032 | WhatsApp delivery blocked — recipient enrolled in a Meta experiment | No |
| 63038 | Account exceeded daily message limit (trial: 50/day; unverified biz: 20,000/day) | No — wait for rolling window reset |
| 63049 | Meta declined to deliver a WhatsApp **marketing** template | No for US recipients; delayed retry only outside US |
| 63051 | WhatsApp sender/WABA locked (inactivity, policy violation, verification mismatch) | No — re-register sender first |
| 21211 | Invalid `To` — not E.164 | No |
| 21610 | Recipient replied STOP (unsubscribed) | No, until they text START |
| 21614 | `To` not a valid mobile number | No |
| 21617 | `Body` exceeds 1600-char Twilio cap | No — shorten |
| 21620 | Invalid `MediaUrl` (malformed, usually missing protocol) | No |
| 20003 | Permission denied — bad/expired/mis-scoped credentials | No |
| 20429 | Account exceeded REST API concurrency (HTTP 429) | **Yes** — "safe to retry after backing off" |
| 30007 | Message filtered by Twilio or carrier (policy/spam) | No |
| 30008 | Unknown carrier-side delivery failure | Often yes — transient (device off/roaming) |

`63023`, `92005`/`21654`/`21656` (Content Template `ContentSid`/`ContentVariables` required-or-invalid) also appeared in search results but weren't independently fetched — UNVERIFIED for exact wording.

## 6. Authentication and ID formats

Two auth modes for the REST API: HTTP Basic with **Account SID + Auth Token**, or HTTP Basic with **API Key SID + API Key Secret** (Account SID still goes in the URL path; "use API keys for your applications unless the API reference specifies Account SID and Auth Token"). VERIFIED(doc: https://www.twilio.com/docs/iam/keys/api, via WebSearch summary — not independently re-fetched, UNVERIFIED at word-for-word level but consistent across two independent secondary confirmations).

Regexes (VERIFIED(doc) per-resource page as cited above):
| Prefix | Resource | Pattern |
|---|---|---|
| `AC` | Account SID | `^AC[0-9a-fA-F]{32}$` |
| `SK` | API Key SID | `^SK[0-9a-fA-F]{32}$` |
| `MG` | Messaging Service SID | `^MG[0-9a-fA-F]{32}$` (UNVERIFIED — inferred from the standard 34-char Twilio SID convention, not independently fetched) |
| `HX` | Content SID | `^HX[0-9a-fA-F]{32}$` |
| `SM`/`MM` | Message SID | `^(SM\|MM)[0-9a-fA-F]{32}$` |
| `ME` | Media SID | `^ME[0-9a-fA-F]{32}$` |

## 7. Media

**Inbound URL:** `https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages/{MessageSid}/Media/{MediaSid}.json` (the underlying binary is fetched by requesting this URL without `.json`, or via the `uri` in the Media resource's JSON body). VERIFIED(doc: https://www.twilio.com/docs/messaging/api/media-resource).

**Auth requirement:** "Twilio enforces HTTP Basic Authentication for all media URLs" — credentials are an API Key SID/Secret (or Account SID/Auth Token for local testing). As of the 2025–2026 rollout, **newly-created main accounts get this enabled by default with no option to disable it**; subaccounts inherit the parent's setting; pre-existing accounts that had it off keep it off unless they opt in. VERIFIED(doc: media-resource for the auth-required statement; doc: https://www.twilio.com/en-us/changelog/extended-notice-and-update-security-changes-http-auth-for-media for the default-for-new-accounts rollout, via WebSearch summary — UNVERIFIED at exact-wording level).

**Redirect target hosts:** community/secondary sources describe an unsecured media URL served from `s3-external-1.amazonaws.com` and a secured/authenticated one from `mms.twiliocdn.com`, with a 307 redirect to a signed URL on the second hop (auth header must not be forwarded past the redirect). **Could not confirm on any twilio.com/docs or support.twilio.com page** — the relevant support article (`support.twilio.com/hc/.../223183748`) returned HTTP 403 to WebFetch on two attempts, and `help.twilio.com`'s mirror rendered no extractable content. UNVERIFIED, community-reported only.

**Retention:** "Twilio retains the stored media until you delete the related Media subresource instance" — no automatic expiry stated for inbound media at the Twilio-storage layer. VERIFIED(doc: media-resource). (This differs from Meta's own Cloud API, where inbound media IDs expire in 7 days — that constraint doesn't apply once Twilio has ingested and stored the media.)

**Outbound size/type limits (WhatsApp):**
- Images: JPG/JPEG/PNG (WEBP reserved for stickers), **5 MB** max.
- Audio: OGG (opus only), AMR, 3GP, AAC, MPEG.
- Video: MP4 (H.264 + AAC).
- Documents: PDF, DOC/DOCX, PPT/PPTX, XLS/XLSX.
- Contacts: vCard (`.vcf`).
- Overall per-message media cap: **20 MB** (changelog notes a bump to messages "up to 16MB" at an earlier date, and the currently-fetched guidance page states 20MB as the WhatsApp ceiling — treat 20MB as current). VERIFIED(doc: https://www.twilio.com/docs/whatsapp/guidance-whatsapp-media-messages, https://www.twilio.com/docs/messaging/guides/accepted-mime-types).
- Twilio validates by checking the `Content-Type` header returned at `MediaUrl` against the actual file; a mismatch is rejected. VERIFIED(doc: guidance-whatsapp-media-messages).
- **One media item per WhatsApp message** — extra `MediaUrl{N}` values are silently ignored (§5). Twilio does **not** support setting a document filename or a caption on documents sent via WhatsApp; and `Body`+media cannot be combined for webp/video/audio/document. VERIFIED(doc: guidance-whatsapp-media-messages).
- `Body` text cap is **1600 characters** at the Twilio API layer (error 21617), which is Twilio's own ceiling — not WhatsApp's native ~4096/65536 char limits; Twilio's value is the one that actually applies when sending through this API. VERIFIED(doc: https://www.twilio.com/docs/api/errors/21617).

## 8. 24-hour customer service window and Content Templates

A session opens/refreshes whenever the user messages in; outside that window, freeform sends fail with **63016** and only approved templates (via `ContentSid`) succeed. VERIFIED(doc: https://www.twilio.com/docs/whatsapp/api/error-code-mapping, https://www.twilio.com/docs/api/errors/63016).

Sending a template: omit `Body`/`MediaUrl`, pass `ContentSid` (an `HX...` template), and if it has variables, `ContentVariables` as a JSON string keyed by placeholder number as text, e.g. `{"1":"coupon_code","2":"docs"}` — Twilio falls back to the template's default placeholder value for any omitted key. VERIFIED(doc: https://www.twilio.com/docs/content/send-templates-created-with-the-content-template-builder, https://www.twilio.com/docs/content/using-variables-with-content-api).

## 9. WhatsApp sender configuration and Sandbox

Production senders are configured under **Console → Messaging → Senders → WhatsApp Senders** (per-sender incoming-webhook and status-callback URLs), or under a **Messaging Service's Integration** tab if the sender is routed through one. An optional fallback URL can also be set here. VERIFIED(doc: https://www.twilio.com/docs/whatsapp/api, via WebSearch summary of that page — page itself gave a thin extract; treat wording as UNVERIFIED but the two-location claim as consistent with the Sandbox doc below).

**Sandbox** (`whatsapp:+14155238886`, shared number): end users opt in by sending `join <your-code>` (or scanning a QR code); only joined numbers can receive sandbox messages. Both the incoming webhook and the status-callback URL are set under the **legacy Console → Sandbox settings → Sandbox configuration** page ("When a Message Comes In" / "Status callback URL" fields). Constraints: 1 msg/3s throughput, 3-day session expiry, only 3 pre-approved sandbox templates (appointment reminder, order notification, verification code), no load testing, and possible temporary country restrictions. VERIFIED(doc: https://www.twilio.com/docs/whatsapp/sandbox).

## Sources

- https://www.twilio.com/docs/messaging/guides/webhook-request
- https://www.twilio.com/docs/usage/webhooks/webhooks-security
- https://www.twilio.com/docs/usage/webhooks/messaging-webhooks
- https://www.twilio.com/docs/usage/webhooks/webhooks-overview
- https://www.twilio.com/docs/usage/webhooks/webhooks-faq
- https://www.twilio.com/docs/usage/webhooks/getting-started-twilio-webhooks
- https://www.twilio.com/docs/usage/security
- https://www.twilio.com/docs/messaging/guides/track-outbound-message-status
- https://www.twilio.com/docs/messaging/guides/outbound-message-status-in-status-callbacks
- https://www.twilio.com/docs/messaging/api/message-resource
- https://www.twilio.com/docs/messaging/api/media-resource
- https://www.twilio.com/docs/messaging/guides/accepted-mime-types
- https://www.twilio.com/docs/whatsapp/api
- https://www.twilio.com/docs/whatsapp/sandbox
- https://www.twilio.com/docs/whatsapp/buttons
- https://www.twilio.com/docs/whatsapp/message-features
- https://www.twilio.com/docs/whatsapp/guidance-whatsapp-media-messages
- https://www.twilio.com/docs/whatsapp/api/error-code-mapping
- https://www.twilio.com/docs/content/content-api-resources
- https://www.twilio.com/docs/content/send-templates-created-with-the-content-template-builder
- https://www.twilio.com/docs/content/using-variables-with-content-api
- https://www.twilio.com/docs/iam/keys/api
- https://www.twilio.com/docs/iam/api/secondary_authtoken
- https://www.twilio.com/docs/api/errors/{11200,20003,20429,21211,21610,21614,21617,21620,63001,63003,63005,63007,63016,63018,63019,63021,63024,63025,63030,63032,63038,63049,63051}
- https://www.twilio.com/en-us/changelog/new-parameters-in-callbacks-for-inbound-whatsapp-messages
- https://www.twilio.com/en-us/changelog/whatsapp-inbound-messages-will-now-include-reply-context
- https://www.twilio.com/en-us/changelog/whatsapp-usernames--new-business-scoped-user-id--bsuid--field-re
- https://www.twilio.com/en-us/changelog/upcoming-security-changes-enforcing-http-authentication-for-media
- https://www.twilio.com/en-us/changelog/extended-notice-and-update-security-changes-http-auth-for-media
- https://github.com/twilio/twilio-node/blob/main/src/webhooks/webhooks.ts (fetched via raw.githubusercontent.com/twilio/twilio-node/main/src/webhooks/webhooks.ts)
