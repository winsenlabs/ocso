# 10: WhatsApp message templates (Twilio Content API and Meta Cloud API)

Researched 2026-09-22. **Method:** I started with WebSearch to find the current docs. For Twilio, I pulled the machine-readable sources first: the official OpenAPI specs `raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_content_v1.json` (v1.1.0) and `.../twilio_content_v2.json`, the SDK sources `twilio-node/src/rest/content/v1/{content,contentAndApprovals}.ts`, `.../content/{approvalCreate,approvalFetch}.ts` and `src/base/Page.ts`, and `twilio-python/twilio/rest/content/v1/content/approval_create.py`. I then fetched the raw HTML of the primary docs pages with curl and converted it to text: `content/content-api-resources`, `content/content-types-overview`, `content/using-variables-with-content-api`, `content/twilio-{text,media,quick-reply,call-to-action}`, `content/create-and-send-your-first-content-api-template`, `whatsapp/tutorial/message-template-approvals-statuses`, `whatsapp/tutorial/send-whatsapp-notification-messages-templates`, `events/event-types/messaging/template-approval`, and `api/errors/{63016,63027,63028,63040,63041,63042,63046}`. Unlike WebFetch, which gave thin SPA output in `06`, curl returned the full page text, so the doc quotes below are direct. For Meta, `developers.facebook.com` HTML returned HTTP 400 to curl and HTTP 500 to WebFetch on several pages. Meta publishes **Markdown twins** of every docs page, listed in `developers.facebook.com/documentation/business-messaging/whatsapp/llms.txt`, and I fetched those with curl: `reference/whatsapp-business-account/message-template-api.md`, `reference/whatsapp-business-phone-number/message-api.md`, `templates/{overview,components,template-management,template-pausing,template-archival}.md`, `webhooks/reference/{message_template_status_update,template_category_update,message_template_quality_update}.md`, and `support/error-codes.md`. I also used Meta's official OpenAPI spec `github.com/facebook/openapi/business-messaging-api_v23.0.yaml` (the only file in that repo, pushed 2026-08-11), plus WebFetch of the Graph API reference pages `whats-app-business-account/message_templates/`, `whats-app-business-hsm/` and `graph-api/changelog/`. Finally, I checked real-world consumers of Twilio's `approval_requests` shape on GitHub via `gh api search/code` (see §2.1), because the spec and live usage disagree. Tags: `VERIFIED(doc|spec|code: url)` means I read the fact myself at that source. `UNVERIFIED` gives the reason.

## TL;DR

- **Twilio has two-step templates.** First `POST https://content.twilio.com/v1/Content` with a **JSON** body (the Messages API uses a form body), which returns an `HX…` SID. Then `POST /v1/Content/{sid}/ApprovalRequests/whatsapp` with `{name, category}` submits it to Meta. A Content resource that is never submitted stays at approval status `unsubmitted` forever. OCSO's `DRAFT` state maps to exactly this, and Meta has no equivalent (Meta templates enter review the moment they are created).
- **Twilio approval statuses** (lowercase in the API): `unsubmitted`, `received`, `pending`, `approved`, `rejected`, `paused`, `disabled`. VERIFIED(doc). **Meta template statuses:** `APPROVED`, `ARCHIVED`, `DELETED`, `DISABLED`, `IN_APPEAL`, `LIMIT_EXCEEDED`, `PAUSED`, `PENDING`, `PENDING_DELETION`, `REJECTED`. VERIFIED(doc). Meta's webhook `event` adds values that are events, not statuses: `FLAGGED`, `LOCKED`, `REINSTATED`, `UNARCHIVED`.
- **Listing:** use Twilio `GET /v1/ContentAndApprovals` (the list key is `contents`, paginated via `meta.next_page_url`, and `Page=` is not supported). `GET /v1/Content` and `GET /v1/Content/{sid}` do **not** include approval state. The per-template `GET /v1/Content/{sid}/ApprovalRequests` returns it under a **`whatsapp`** key.
- **Watch the `approval_requests` shape.** The spec and the SDK show `approval_requests` in ContentAndApprovals as a **flat** object (`{name, category, content_type, status, rejection_reason, allow_category_change}`). Several production codebases on GitHub instead read `approval_requests.whatsapp.status`. Parse both. See §2.1.
- **Listing on Meta:** `GET /{WABA-ID}/message_templates?fields=…&limit=…` returns `{data:[…], paging:{cursors:{before,after}, next?, previous?}}`. The default fields do **not** include `rejected_reason` or `quality_score`, so always pass `fields=`. VERIFIED(doc). Meta's `DELETE` takes `name` (deletes all languages), `hsm_id`+`name` (one template), or `hsm_ids` (up to 100, cannot be combined with the others), and returns `{success:true}`. Twilio's `DELETE /v1/Content/{sid}` returns **204** and by default removes only the Twilio copy (`deleteInWaba=true` also deletes it in the WABA).
- **Named parameters.** Meta supports `{{first_name}}` natively through `parameter_format: "NAMED"` and `body_text_named_params`. It uses `parameter_name` at send time. VERIFIED(doc). Twilio's own WhatsApp-approval rules are written entirely in **sequential numeric** terms (`{{1}}`, `{{2}}`, …, "definitions should not skip over integers"). Twilio variable keys *may* be alphanumeric in general, but no Twilio doc says that named keys survive WhatsApp approval. **OCSO should create Twilio WhatsApp templates with numeric keys only.** UNVERIFIED for named keys.
- **Meta sends `message_template_id` as a JSON *integer*** in all template webhooks, but `id` as a *string* in REST responses. The webhook doc examples also use a hyphenated language code (`"en-US"`), while REST uses underscores (`"en_US"`). Normalize both before matching. VERIFIED(doc).
- **The current Graph API version is v26.0** (released 2026-07-29), which matches OCSO's default. VERIFIED(doc). Meta's published OpenAPI file is still the v23.0 snapshot. The request and response shapes cited below match between it and the v26.0-era Markdown reference.

## 1. Twilio: authentication, base URL, SID formats

- Base URL `https://content.twilio.com`. All operations declare `security: accountSid_authToken`, which is `{type: http, scheme: basic}`. VERIFIED(spec: twilio_content_v1.json `components.securitySchemes`). Every doc sample uses `-u $TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN`. VERIFIED(doc: content-api-resources).
- API Key SID/Secret as Basic credentials. The Content API docs never mention this, so it is UNVERIFIED for `content.twilio.com` specifically. It is high-confidence because the Twilio SDKs use one client credential for every domain, and `06 §6` covers API-key auth for the REST API generally.
- Request bodies for `POST /v1/Content`, `PUT /v1/Content/{sid}` and `POST …/ApprovalRequests/whatsapp` are **`application/json`**. VERIFIED(spec: `requestBody.content["application/json"]`). The SDK sets `Content-Type: application/json`. VERIFIED(code: twilio-node approvalCreate.ts L134).
- Content SID pattern: `^HX[0-9a-fA-F]{32}$`, 34 chars. Account SID pattern: `^AC[0-9a-fA-F]{32}$`. VERIFIED(spec).

## 2. Twilio: list and get

### 2.1 `GET /v1/ContentAndApprovals` (use this one)

Query params: `PageSize` (int 1–1000, default 50), `Page` ("simply for client state"), `PageToken`. VERIFIED(spec). The docs narrow this: "`PageSize` (recommended maximum: 500). The response is limited to 1 MB, which is roughly 500 templates. `PageToken`: Use the `meta.next_page_url` value from the previous response to request the next page. **Supplying a page number (page=) is not supported.**" VERIFIED(doc: content-api-resources §Pagination). So follow `meta.next_page_url` verbatim until it is `null`. The SDK does exactly this (`getNextPageUrl()` reads `payload.meta.next_page_url`; `loadPage()` reads `payload[payload.meta.key]`). VERIFIED(code: twilio-node src/base/Page.ts).

Response: `{ "contents": [item…], "meta": { "page", "page_size", "first_page_url", "previous_page_url" (nullable), "url", "next_page_url" (nullable), "key": "contents" } }`. VERIFIED(spec: `ListContentAndApprovalsResponse`).

Each item (`content.v1.content_and_approvals`) has `date_created`, `date_updated` (ISO-8601 `…Z` in examples), `sid`, `account_sid`, `friendly_name`, `language`, `variables` (object), `types` (object), and `approval_requests` (object, nullable). **It has no `url` and no `links`**, unlike `/v1/Content`. VERIFIED(spec schema + example). The SDK maps exactly these nine fields. VERIFIED(code: twilio-node contentAndApprovals.ts L448-456, `approvalRequests: Record<string, object>`).

**`approval_requests` shape.** There is conflicting evidence, so implement both shapes:
- The spec example shows it **flat**: `{"name":"","category":"","content_type":"","status":"unsubmitted","rejection_reason":"","allow_category_change":true}` for a never-submitted item, and `{"category":"TRANSACTIONAL","status":"approved","rejection_reason":"","name":"Media Test","content_type":"twilio/media","allow_category_change":false}` for an approved one. VERIFIED(spec: v1 and v2 `readResults` examples, identical). Open-source consumers that read it flat: DiscipleTools/disciple-tools-channels-twilio (`$content['approval_requests']['status']`), susom/whats-app-alerts, socialincome-san/public, rhernandezbas/ipnext-backend.
- Other consumers read it **keyed by channel**, `approval_requests.whatsapp.status`: David-Sousa-Web/Bizap (twilio-node `content.v1.contentAndApprovals.list()`), roberto-alarcon-seo/notyfive (`/v2/ContentAndApprovals`), sanyagouan/cerebro-en-las-nubes. Odoo-KRD even handles an array. UNVERIFIED which one live v1 returns. Code that shipped against the API disagrees, so the live shape may have changed or may differ between v1 and v2.
- **Defensive parse:** `const a = item.approval_requests; const wa = a?.whatsapp ?? (Array.isArray(a) ? a.find(x => x?.type === 'whatsapp' || x?.status) : a);`. A missing, `null` or `{}` value, or an empty `status`, means `unsubmitted`. When the status matters (for example, before sending), confirm it with the unambiguous per-SID endpoint in §2.3.

**Legacy categories.** The spec's own examples use `"category":"TRANSACTIONAL"`, a pre-2023 WhatsApp category. Map `TRANSACTIONAL`→`UTILITY` and `OTP`→`AUTHENTICATION`. Meta's list-filter enum still accepts both. VERIFIED(doc: Graph ref message_templates `category` enum). The status strings are lowercase in the API. The prose docs capitalize them, and Event Streams sends them lowercase (§5). Compare case-insensitively.

**Rejection reasons** come back as free text, sometimes Meta's raw error, for example `"INVALID_FORMAT. Facebook is not able to create template with templateName=Video Highlights_hx15c711fcc6d9ea5268d7ab77938a20ff due to the following error: … component of type HEADER is missing expected field(s) (example)"`. VERIFIED(spec example). The two codes Twilio says WhatsApp discloses are `TAG_CONTENT_MISMATCH` and `INVALID_FORMAT`. VERIFIED(doc: message-template-approvals-statuses). Store the string as-is.

**Twilio suffixes the WhatsApp-side name.** The event example shows `friendlyName: "owl_update"` next to `externalTemplateName: "owl_update_hx123456"`, and the rejection text above shows `templateName=Video Highlights_hx15c7…`. VERIFIED(doc: events/template-approval; spec example). The exact suffix rule is UNVERIFIED. **Key Twilio templates by Content SID, never by name.**

### 2.2 `GET /v1/Content` and `GET /v1/Content/{sid}`

These take the same pagination params. The list key is `contents` and the list title is `ListContentResponse`. Each item (`content.v1.content`) has `date_created`, `date_updated`, `sid`, `account_sid`, `friendly_name`, `language`, `variables`, `types`, `url`, and `links: {approval_create, approval_fetch}`. **There is no approval state.** VERIFIED(spec; code: twilio-node content.ts L914-923).

**v2 search.** `GET /v2/Content` and `GET /v2/ContentAndApprovals` add the filters `SortByDate`, `SortByContentName`, `DateCreatedAfter`/`DateCreatedBefore`, `ContentName` (regex), `Content` (regex), `Language[]`, `ContentType[]`, and `ChannelEligibility[]` (`<channel>:<status>`, e.g. `whatsapp:approved`). VERIFIED(spec: twilio_content_v2.json; doc: "GET …/v2/ContentAndApprovals?ChannelEligibility=whatsapp:unsubmitted&Language=en"). `ChannelEligibility=whatsapp:approved` is a cheap "sendable only" filter.

### 2.3 `GET /v1/Content/{sid}/ApprovalRequests`

The response is `{ "sid", "account_sid", "whatsapp": {…}|null, "url" }`. The `whatsapp` object is untyped in the spec, but the documented example contains `{"type":"whatsapp","name","category","content_type","status","rejection_reason","allow_category_change"}`. VERIFIED(spec `content.v1.content.approval_fetch` + example; doc: content-api-resources "Fetch an approval status request"; code: twilio-node approvalFetch.ts L170-173). What happens for a never-submitted SID is UNVERIFIED. One consumer (ipnext-backend) treats a 404 as "never submitted", and `whatsapp` could also be `null` or `{}`. Handle all three as `unsubmitted`.

## 3. Twilio: create, edit, delete

### 3.1 `POST /v1/Content` returns 201

Body (`ContentCreateRequest`): `friendly_name` (string, optional), `language` (string, **required**), `variables` (object of string→string, optional), `types` (object, **required**). VERIFIED(spec; code). Response: the full `content.v1.content` including `url` and `links`. VERIFIED(spec 201 example; doc).

`types` keys (VERIFIED(spec `types` schema)) are `twilio/text`, `twilio/media`, `twilio/location`, `twilio/list-picker`, `twilio/call-to-action`, `twilio/quick-reply`, `twilio/card`, `twilio/catalog`, `twilio/carousel`, `twilio/flows`, `twilio/schedule`, `whatsapp/card`, `whatsapp/authentication`, `whatsapp/flows`. The docs also list `twilio/pay`, which is not in the spec. Shapes (all `additionalProperties:false`):

| type | fields (required marked *) |
|---|---|
| `twilio/text` | `body`* |
| `twilio/media` | `body`, `media`* (string[]) |
| `twilio/location` | `latitude`*, `longitude`*, `label`, `id`, `address` |
| `twilio/list-picker` | `body`*, `button`*, `items`* `[{id*, item*, description}]` |
| `twilio/call-to-action` | `body`*, `actions`* `[{type* URL\|PHONE_NUMBER\|COPY_CODE\|VOICE_CALL\|VOICE_CALL_REQUEST\|REQUEST_CONTACT_INFO, title, url, phone, code, id}]` |
| `twilio/quick-reply` | `body`*, `actions`* `[{type QUICK_REPLY, title*, id}]` |
| `twilio/card` | `title`, `subtitle`, `media` (string[]), `actions` `[{type* URL\|PHONE_NUMBER\|QUICK_REPLY\|COPY_CODE\|VOICE_CALL, title*, url, phone, id, code, webview_size}]` |
| `whatsapp/card` | `body`*, `footer`, `media` (string[]), `header_text`, `actions` (same as card) |
| `whatsapp/authentication` | `actions`* `[{type* COPY_CODE, copy_code_text*}]`, `add_security_recommendation`, `code_expiration_minutes` |
| `twilio/catalog` | `body`*, `title`, `subtitle`, `id`, `items`, `dynamic_items` |
| `twilio/carousel` | `body`*, `cards`* `[{title, body*, media* (string), actions*}]` (max 10 cards) |
| `whatsapp/flows` | `body`*, `button_text`*, `flow_id`*, `subtitle`, `media_url`, `flow_token`, `flow_first_page_id`, `is_flow_first_page_endpoint` |

VERIFIED(spec component schemas). **Doc inconsistency:** the `twilio/call-to-action` doc page writes the phone type as `PHONE`, while the spec enum and the content-types-overview "Common components" table say `PHONE_NUMBER`. Trust the spec.

A single Content resource can carry several `types`. Twilio sends "the most complex translation that the chosen channel supports." VERIFIED(doc: content-types-overview). `approval_requests.content_type` tells you which type was submitted to WhatsApp.

**Constraints relevant to a builder:**
- Variables. Keys "can be numeric or alphanumeric, but they can't contain spaces". "A single template can contain up to 100 variables." "A variable key has a maximum length of 16 characters." "A variable value can be up to 1,600 characters." VERIFIED(doc: using-variables). The `variables` map doubles as **default send values and approval samples**: "use self-evident default variable values. These values are used as sample values during the approval process." VERIFIED(doc: create-and-send-your-first-content-api-template). "A sample value for each variable is required." VERIFIED(doc: twilio-quick-reply).
- WhatsApp approval rules for variables. All of these are VERIFIED(doc: using-variables §WhatsApp variable rules; twilio-text/media/quick-reply/call-to-action warnings; message-template-approvals-statuses):
  - Numbering must be sequential with no skipped integers (`{{1}} … {{3}}` without `{{2}}` is rejected). The numbers may appear out of order in the text.
  - Variables must not be adjacent: `{{1}} {{2}}` counts as adjacent, so put a word between them.
  - Text must not start or end with a variable. "Meta considers variables strings ending in a variable followed by punctuation as a variable at the end."
  - For every *x* variables there must be at least 2x+1 non-variable words.
  - Variable values in approved templates cannot contain newlines.
  - A URL variable must come after a `/` following the domain.
  - The body must not contain newlines, tabs or more than 4 consecutive spaces (per the approvals page; Twilio's own examples contain `\n`, so treat this as Meta-reviewer guidance).
  - At most 10 emojis.
- Body limits: `twilio/text` 1,600; `twilio/media` body 1,600 ("Only required to get content template approved by WhatsApp"); `twilio/quick-reply` 1,024; `twilio/call-to-action` 640. VERIFIED(doc per page). Meta's own limit for a template body is 1,024 (§7.2). Whether Twilio enforces 1,024 on `twilio/text` at approval time is UNVERIFIED, so cap at 1,024 in the builder.
- Quick reply: "up to ten quick-reply buttons. When you send an in-session WhatsApp message that does not require template approval, only three buttons are allowed." VERIFIED(doc). The button `title` limit conflicts between Twilio pages: 20 chars (quick-reply page) versus 25 for WhatsApp (common components). The `id` limit also conflicts: 200 (quick-reply page) versus 128 for approved WhatsApp and 256 in-session (common components). Use **20 and 128**.
- Call-to-action: "Up to two URL buttons", only one of `PHONE`/`VOICE_CALL`, and up to 5 quick replies mixed in. `title` is at most 20 chars and does not support variables. A URL supports "Variables … at the end of the URL string". `REQUEST_CONTACT_INFO` excludes all other buttons. An unapproved in-session send allows 3 buttons, all of the same action type, with no `PHONE_NUMBER` and only 1 URL. VERIFIED(doc: twilio-call-to-action).
- Media: "a valid media sample is required". A media URL variable is allowed "only after the domain" (`https://www.example.com/{{1}}`, with the sample path in `variables`). "The combined URL must contain the file type and must resolve to a publicly hosted file." The approved sample locks the header type: "if a content template is approved with an image, a video cannot be sent using the same content template." VERIFIED(doc: twilio-media).
- The approval-request `name` "Accepts only lowercase alphanumeric characters and underscores." Twilio documents no max length (Meta's limit is 512, §7.2). "WhatsApp prevents reuse of the same template name for 30 days" after rejection or deletion. VERIFIED(doc: content-api-resources; message-template-approvals-statuses).
- `language`: the spec describes it as "Two-letter (ISO 639-1) language code (e.g., en)". It **cannot be changed after WhatsApp submission**. VERIFIED(spec; doc). Whether locale codes (`pt_BR`, `en_US`) are accepted is UNVERIFIED (not stated), so store the raw value.
- Account cap: "The Content API supports an unlimited number of content templates, but WhatsApp limits each account to 6,000 approved templates." VERIFIED(doc).

### 3.2 `PUT /v1/Content/{sid}` returns 200

`ContentUpdateRequest` has the same fields as create, and only `types` is required. VERIFIED(spec). "You can edit a content template if it hasn't been submitted for approval on WhatsApp … editing a content template doesn't change its content SID." "You can't edit content that you've submitted for WhatsApp approval, nor can you change its language." VERIFIED(doc). So only OCSO `DRAFT` templates are editable on Twilio. For a submitted template, create a new one and delete the old one.

### 3.3 `DELETE /v1/Content/{sid}` returns 204

"The resource was deleted successfully" (204, no body). VERIFIED(spec). "By default, a DELETE request only removes the template from Twilio." `deleteInWaba` (Boolean, default false): "If the template was synchronized from WABA or legacy templates, set this parameter to `true` to delete the template both in Twilio and in the WABA." VERIFIED(doc). The spec does not declare `deleteInWaba`, so its exact casing and whether it goes in the query string are UNVERIFIED. Send it as a query param, `?deleteInWaba=true`, and expect that the flag may be ignored for templates created through the Content API rather than synced.

## 4. Twilio: submit for WhatsApp approval

`POST /v1/Content/{ContentSid}/ApprovalRequests/whatsapp` with a JSON body. The docs page heading writes `…/WhatsApp`, while the curl sample, spec and SDK all use lowercase `whatsapp`. Use lowercase. VERIFIED(spec; code: twilio-node approvalCreate.ts L115).

Request (`ContentApprovalRequest`): `name` (string, **required**), `category` (string, **required**; "Valid values: UTILITY, MARKETING, AUTHENTICATION"), `send_ttl_seconds` (int, optional). VERIFIED(spec; code: twilio-node `ContentApprovalRequest` class, twilio-python `approval_create.py` `to_dict()` = `{name, category, send_ttl_seconds}`; doc). **`allow_category_change` is not a request field** in the spec or either SDK, only a response field. Don't send it. Whether the server tolerates it is UNVERIFIED.

The response is **201** with a flat object (`content.v1.content.approval_create`): `name`, `category`, `content_type`, `status`, `rejection_reason`, `allow_category_change`, `send_ttl_seconds` (all nullable). VERIFIED(spec; code: approvalCreate.ts L243-249). The docs example returns `status: "received"` and omits `allow_category_change`. The spec example returns `status: "unsubmitted"` and includes it. Treat every field as optional.

"WhatsApp typically approves or rejects it within minutes through a machine-learning assisted process. Templates that cannot be triaged automatically are routed for human review and can take up to 48 hours." VERIFIED(doc: message-template-approvals-statuses). A different Twilio page says "5 minutes and 24 hours". **Poll with backoff.** Twilio has no webhook on the Content API itself. Push options are Event Streams (§5) or Alarms on error codes 63040/63041/63042/63046.

## 5. Twilio: statuses, push notifications, sendability

**Statuses** (VERIFIED(doc: content-types-overview "WhatsApp approval statuses")):

| Status | Doc definition (abridged) |
|---|---|
| `unsubmitted` | Not submitted. "might still be used in session for some channels and in some WhatsApp sessions" |
| `received` | "received by Twilio. It's not yet in review by WhatsApp" |
| `pending` | "under review by WhatsApp" |
| `approved` | "approved by WhatsApp and can be used to notify customers" |
| `rejected` | "rejected by WhatsApp during the review process" |
| `paused` | "paused by WhatsApp due to recurring negative feedback … can't be sent" |
| `disabled` | "disabled … for violating one or more of WhatsApp's policies … can't be sent" |

No other values are documented. Meta's `IN_APPEAL`, `ARCHIVED` or `DELETED` could surface through Twilio, but that is UNVERIFIED, so an unknown value should map to `PENDING` with the raw string logged, not crash.

**Event Streams:** the event type is `com.twilio.messaging.template.approval.updated` (a CloudEvent). `data` = `{type: "status_update"|"category_update"|"quality_update"|"direct_send_category_notice"|"direct_send_abuse_update", accountSid, dateUpdated, channel: "whatsapp", template: {sid, friendlyName, externalTemplateName, language, previousValue, currentValue}}`. The values are **lowercase** (`"approved"`→`"paused"`, `"utility"`→`"marketing"`, `"green"`→`"yellow"`). VERIFIED(doc: https://www.twilio.com/docs/events/event-types/messaging/template-approval; changelog dated 2026-07-27). **Alarms/Debugger codes:** 63040 Template Rejected, 63041 Template paused, 63042 Template disabled, 63046 Template approved (beta). VERIFIED(doc: api/errors/*; send-whatsapp-notification-messages-templates).

**Sendability** (VERIFIED(doc: content-types-overview "WhatsApp approval requirements"; api/errors/63016)):

| Content type | In 24h session, unapproved | Outside session |
|---|---|---|
| `twilio/text`, `twilio/media`, `twilio/quick-reply`, `twilio/catalog` | allowed | approval required |
| `twilio/list-picker`, `twilio/location`, `twilio/pay` | allowed | **not supported at all** |
| `twilio/call-to-action`, `twilio/card`, `whatsapp/card` | "approval might be required … based on buttons types present" | approval required |
| `twilio/carousel`, `twilio/flows`, `whatsapp/authentication` | approval required | approval required |

So yes: an **unsubmitted** Content template *is* sendable in-session for text, media and quick-reply (at most 3 buttons). Only `approved` is sendable outside the window. Out-of-window failures return 63016 ("You used a content type that cannot start a business-initiated WhatsApp conversation, such as twilio/list-picker or twilio/location"). The specific error code for an unapproved-but-supported type sent out-of-window is UNVERIFIED (probably 63016). Other send-time codes: 63027 (template doesn't exist for that language, or wrong params), 63028 (`ContentVariables` count mismatch; "For WhatsApp templates, variable definitions skip integers" also triggers it). VERIFIED(doc). OCSO's current `isTemplateSendable` requires `APPROVED`. That is correct for out-of-window, and conservative in-session.

## 6. Meta: authentication, version, IDs

- Base URL `https://graph.facebook.com/v26.0`. v26.0 was released 2026-07-29 with sunset TBD. v25.0 (2026-02-18) runs until 2028-07-29. VERIFIED(doc: https://developers.facebook.com/docs/graph-api/changelog/). The reference page title reads "Graph API Reference v26.0: WhatsApp Message Template". VERIFIED(doc).
- `Authorization: Bearer <token>` is a system-user token with the **`whatsapp_business_management`** permission for list, create, edit and delete. VERIFIED(spec securitySchemes description; doc: Graph ref message_templates "Required Permissions"). Sending uses the phone-number messages endpoint and needs `whatsapp_business_messaging` (see `02`).
- Template `id` is a numeric **string** in REST responses (`"1387372356726668"`) and an **integer** in webhooks (`1689556908129832`). VERIFIED(doc). The values seen are about 1.7e15, which is below 2^53, but store them as strings and coerce the webhook value with `String()`.
- Error envelope: `{"error":{"message","type","code","error_subcode?","fbtrace_id","is_transient?","error_user_title?","error_user_msg?"}}`. VERIFIED(doc: message-template-api.md `GraphAPIError`). The docs claim 404/`803` for a missing template or WABA, which is UNVERIFIED on live (Graph often returns 400/`100` with a subcode for unknown objects). Treat both as "not found".

## 7. Meta: list, get, create, edit, delete

### 7.1 `GET /{WABA-ID}/message_templates`

Query: `fields` (comma list), `limit` (int ≥1), `after`, `before`. VERIFIED(doc: message-template-api.md). The Graph reference adds the filters `category`, `content`, `language` (array), `name`, `name_or_content`, `quality_score` (`GREEN|YELLOW|RED|UNKNOWN`), `status` (enum below), `since`, `until`, and a `summary` object (`total_count`, `message_template_count`, `message_template_limit`, `are_translations_complete`). VERIFIED(doc: Graph ref `whats-app-business-account/message_templates/`). Doc examples use lowercase filter values (`&status=approved`).

The available `fields` are: `id, ad_account_id, ad_adset_id, ad_campaign_id, ad_id, bid_spec, category, components, correct_category, cta_url_link_tracking_opted_out, degrees_of_freedom_spec, display_format, health_status, is_primary_device_delivery_only, is_sms_fallback_enabled, language, last_updated_time, library_template_name, message_send_ttl_seconds, name, parameter_format, previous_category, quality_score, rejected_reason, source, status, sub_category`. VERIFIED(doc). **The default (no `fields`) response carries `name, parameter_format, components, language, status, category, id` and sometimes `sub_category`/`previous_category`**. VERIFIED(doc: template-management.md example; spec example). Recommended: `fields=id,name,language,status,category,components,parameter_format,rejected_reason,quality_score,previous_category,sub_category`.

Response: `{ "data": [MessageTemplate…], "paging": { "cursors": {"before","after"}, "next"?, "previous"? } }`. `next` and `previous` are full URLs. Loop until `paging.next` is absent. VERIFIED(doc: `MessageTemplatesResponse`/`CursorPaging`; template-management.md example with `"next"`).

Enums (VERIFIED(doc: message-template-api.md schemas; Graph ref `whats-app-business-hsm`)):
- `status`: `APPROVED, ARCHIVED, DELETED, DISABLED, IN_APPEAL, LIMIT_EXCEEDED, PAUSED, PENDING, PENDING_DELETION, REJECTED`. The older `MessageTemplate` schema in the v23 OpenAPI lists only 4 of these, so trust the Markdown reference.
- `category`: `AUTHENTICATION, MARKETING, UTILITY, FREE_SERVICE`. The list filter also accepts legacy values (`TRANSACTIONAL, OTP, ACCOUNT_UPDATE, PAYMENT_UPDATE, …`), and `previous_category` has been seen as `"ACCOUNT_UPDATE"`. VERIFIED(spec example).
- `rejected_reason`: `ABUSIVE_CONTENT, CATEGORY_NOT_AVAILABLE, INCORRECT_CATEGORY, INVALID_FORMAT, NONE, PROMOTIONAL, SCAM, TAG_CONTENT_MISMATCH`. `NONE` is normal for non-rejected templates.
- `parameter_format`: `NAMED, POSITIONAL`. `quality_score`: an object `{score: GREEN|RED|UNKNOWN|YELLOW, reason?, reasons?[], date? (unix int)}`. `source`: `auto_generated|manual`. `sub_category`: `BOOKING_STATUS, CALL_PERMISSIONS_REQUEST, FLIGHT_DELAY_AND_GATE_CHANGE_ALERT, FRAUD_ALERT, ORDER_DETAILS, ORDER_STATUS, RICH_ORDER_STATUS`, but a doc example shows `"CUSTOM"`, so accept any string.

Component shapes returned (VERIFIED(doc: template-management.md, components.md; message-template-api.md `Components`/`Buttons`/`Example`)):
- `{type: "HEADER", format: "TEXT"|"IMAGE"|"VIDEO"|"GIF"|"DOCUMENT"|"LOCATION", text?, example?: {header_text?: string[], header_text_named_params?: [{param_name, example}], header_handle?: string[]}}`. In list responses `header_handle` holds a `https://scontent.whatsapp.net/…` sample URL. `GIF` appears in components.md but not in the reference enum.
- `{type: "BODY", text, example?: {body_text?: string[][], body_text_named_params?: [{param_name, example}]}}`. Authentication bodies carry `add_security_recommendation` instead of `text`.
- `{type: "FOOTER", text}`. Authentication footers carry `code_expiration_minutes`.
- `{type: "BUTTONS", buttons: [{type: "QUICK_REPLY"|"URL"|"PHONE_NUMBER"|"COPY_CODE"|"OTP"|"FLOW"|"MPM"|"CATALOG"|"VOICE_CALL"|…, text, url?, phone_number?, example?: string[]|string, otp_type?, flow_id?, …}]}`.
- `CAROUSEL` and `LIMITED_TIME_OFFER` component types also exist. Component `type` values come back uppercase, but creation examples send `"body"` lowercase, so parse case-insensitively.

### 7.2 `POST /{WABA-ID}/message_templates`

Body: `name`* ("lowercase alphanumeric and underscores only"), `language`*, `category`*, `parameter_format`, `components`, `allow_category_change` ("Allow Meta to reassign the template category"), `cta_url_link_tracking_opted_out`, `message_send_ttl_seconds`, `sub_category`, `display_format`, `library_template_name`, `library_template_button_inputs`, `library_template_body_inputs`, `is_primary_device_delivery_only`, `send_type`. VERIFIED(doc: message-template-api.md). Response: `{id, status, category}` (example `{"category":"UTILITY","id":"1689556908129832","status":"PENDING"}`). VERIFIED(spec example; doc `CreateTemplateResponse`).

Rules (VERIFIED(doc: templates/overview.md, components.md)):
- Names are "limited to a maximum of 512 characters, consisting of lowercase alphanumeric characters and underscores". Names are *not* unique across languages.
- Creation is capped at 100 templates per WABA per hour. A WABA can hold 250 templates if its portfolio is unverified, or 6,000 if verified.
- If you omit `parameter_format`, it defaults to `positional`. Named params "must be unique, single strings, composed of lowercase characters and underscores". Positional params are `{{1}}`… "starting from 1".
- "you must include an example value for each parameter".
- The overview examples send `"category":"utility"` and `"parameter_format":"named"` in lowercase, while the reference enums are uppercase. Send uppercase; server case-insensitivity is UNVERIFIED but implied.
- Limits:
  - HEADER TEXT: 60 chars, 1 parameter. Media headers need an upload handle from the Resumable Upload API.
  - BODY: 1024 chars, one per template.
  - FOOTER: 60 chars, no params.
  - Buttons: at most 10 in total, including at most 10 QUICK_REPLY, 2 URL, 1 PHONE_NUMBER and 1 COPY_CODE.
  - Button text: 25 chars. URL: 2000 chars with 1 variable, which must come at the end. Phone number: 20 chars. Copy-code example: 20 chars.
  - Quick replies and other button types must be grouped, not interleaved.
- Creation-time error codes: `2388040` (character limit), `2388047`/`2388072`/`2388073` (header, body or footer format), `2388293` (too many params for the length), `2388299` ("Variables cannot be at the start or end of the template"), `2388019` (template limit), `100` (invalid parameter, for example the name rule). VERIFIED(doc: support/error-codes.md).

### 7.3 `GET /{TEMPLATE-ID}?fields=…`

This returns one template object with the same `fields` list as §7.1, for example `?fields=status` → `{"status":"APPROVED","id":"1259544702043867"}`. VERIFIED(doc: templates/overview.md).

### 7.4 Edit: `POST /{TEMPLATE-ID}`

Body: `components`, `category`, `parameter_format`, `allow_category_change`, `cta_url_link_tracking_opted_out`, `message_send_ttl_seconds`, `sub_category`, `display_format`, `is_primary_device_delivery_only`. Response: `{"success": true}`. VERIFIED(doc). The Graph reference adds `id, name, category` to the return struct. Rules (VERIFIED(doc: template-management.md)):
- Only templates with status `APPROVED`, `REJECTED` or `PAUSED` can be edited.
- An edit replaces **all** components.
- The category of an approved template cannot be edited.
- Approved templates can be edited at most 10 times per 30 days and once per 24h. Rejected and paused templates have no limit.
- An edit sends the template back to review.
- Editing a template that cannot be changed returns `2388039`.

### 7.5 `DELETE /{WABA-ID}/message_templates`

Query: `name` (deletes **all languages**), `hsm_id`+`name` (deletes that one template), or `hsm_ids=[id,…]` (at most 100, all-or-nothing, "cannot be combined with the `name` or `hsm_id` parameters"). Response: `{"success": true}`. VERIFIED(doc: template-management.md; message-template-api.md; spec). Rules:
- Deleting an approved template blocks its name for 30 days.
- A disabled template cannot be deleted.
- If a sent message is still undelivered, the template goes to `PENDING_DELETION` and delivery is retried for 30 days.

VERIFIED(doc). **For OCSO, always delete by `hsm_id`+`name`**, because name-only deletion wipes the template in every language.

### 7.6 Lifecycle facts that affect status mapping

- **Pausing:** a template is paused automatically when its quality hits `RED`: "1st Instance: Paused for 3 hours; 2nd Instance: Paused for 6 hours; 3rd Instance: Disabled". Unpausing is automatic, or via `POST /{template-id}/unpause`. VERIFIED(doc: template-pausing.md).
- **Archival:** templates inactive for 12 months or more are auto-archived. "Archived templates cannot be sent in template messages and are scheduled for deletion after 28 days", and unarchiving restores the previous status. VERIFIED(doc: template-archival.md).
- **Send-time errors:** `132000` (param count mismatch), `132001` (template doesn't exist in that language or isn't approved), `132005` (translated text too long), `132007` (policy), `132012` (param format mismatch, e.g. positional values sent to a NAMED template), `132015` (paused), `132016` (permanently disabled), `131047` (outside 24h). VERIFIED(doc: error-codes.md).

## 8. Meta: webhooks

These are WABA-object webhook fields. The app must subscribe to each field. All are delivered in the standard envelope `{"object":"whatsapp_business_account","entry":[{"id":"<WABA_ID>","time":<unix>,"changes":[{"field":"…","value":{…}}]}]}`. VERIFIED(doc).

**`message_template_status_update`**: `value` = `{event, message_template_id (int), message_template_name, message_template_language, reason, message_template_category?, disable_info?: {disable_date (unix int)}, other_info?: {title, description}, rejection_info?: {reason, recommendation}}`. VERIFIED(doc: webhooks/reference/message_template_status_update.md).
- `event` values: `APPROVED, ARCHIVED, UNARCHIVED, DELETED, DISABLED, FLAGGED, IN_APPEAL, LIMIT_EXCEEDED, LOCKED, PAUSED, PENDING, REINSTATED, PENDING_DELETION, REJECTED`.
- `reason` values: `ABUSIVE_CONTENT, CATEGORY_NOT_AVAILABLE (deprecated), INCORRECT_CATEGORY, INVALID_FORMAT, NONE ("Indicates template was paused"), PROMOTIONAL, SCAM, TAG_CONTENT_MISMATCH`. The value is `null` "If the template is scheduled for deletion". The approved example also carries `"reason":"NONE"`, so `NONE` is not pause-specific.
- `other_info.title` values: `FIRST_PAUSE, SECOND_PAUSE, RATE_LIMITING_PAUSE, UNPAUSE, DISABLED`. The syntax comment says `other_info` is "only included if template locked or unlocked", while the `TITLE` enum describes pause events. Expect it on pause and unpause too (UNVERIFIED which one is right).
- `rejection_info` appears "only … if template rejected with INVALID_FORMAT reason", and `disable_info` "only … if template disabled".
- Language in the examples is `"en-US"` or `"en"`.
- UNARCHIVED and REINSTATED mean "restored to previous status", so re-fetch `GET /{id}?fields=status` instead of guessing.

**`template_category_update`**: `value` = `{message_template_id (int), message_template_name, message_template_language, previous_category?, new_category, correct_category?, category_update_timestamp?}`. An *impending* change carries `new_category` (current), `correct_category` (the future category) and `category_update_timestamp`. A *completed* change carries `previous_category` and `new_category`. VERIFIED(doc).

**`message_template_quality_update`**: `value` = `{previous_quality_score, new_quality_score (GREEN|RED|YELLOW|UNKNOWN), message_template_id (int), message_template_name, message_template_language}`. VERIFIED(doc).

Webhook signature verification (`X-Hub-Signature-256`) is identical to message webhooks; see `02`.

## 9. Meta: send format (`POST /{PHONE-NUMBER-ID}/messages`)

```json
{"messaging_product":"whatsapp","recipient_type":"individual","to":"+16505551234","type":"template",
 "template":{"name":"order_confirmation","language":{"code":"en_US"},
  "components":[
   {"type":"header","parameters":[{"type":"image","image":{"link":"https://…/img.jpg"}}]},
   {"type":"body","parameters":[{"type":"text","parameter_name":"first_name","text":"Jessica"}]},
   {"type":"button","sub_type":"quick_reply","index":"0","parameters":[{"type":"payload","payload":"CONFIRM"}]},
   {"type":"button","sub_type":"url","index":"1","parameters":[{"type":"text","text":"order/123"}]}]}}
```
- `parameter_name` is set only for NAMED templates. Named values "can appear in any order", while positional values must follow placeholder order. VERIFIED(doc: templates/overview.md send examples).
- Header/body parameter `type` is one of `text|currency|date_time|image|document|video`. Media objects are `{link}` or `{id}`. Text is at most 32768 chars. VERIFIED(spec `ParameterObject`, `TextParameter`).
- Button components need `sub_type` (`quick_reply|url|catalog`, plus `flow`) and `index`. The spec examples mostly use a string `"0"`, but some use an integer, so send a string. Button parameters are `{type:"payload",payload}` for quick replies and `{type:"text",text}` (URL suffix) for URL buttons. VERIFIED(spec).
- `language.policy: "deterministic"` is marked required in the spec schema but omitted in every doc example, so it is optional in practice. The copy-code/coupon button send shape (`sub_type:"copy_code"`, `{type:"coupon_code",coupon_code}`) was not fetched. UNVERIFIED.
- Response: `{"messaging_product":"whatsapp","contacts":[{"input","wa_id"}],"messages":[{"id":"wamid…","message_status"?: "accepted"|"held_for_quality_assessment"|"paused"}]}`. VERIFIED(doc: message-api.md; spec).

## 10. Normalization to OCSO (`packages/domain/src/templates/model.ts`)

| OCSO status | Twilio `approval_requests[.whatsapp].status` | Meta `status` (REST) / `event` (webhook) | Notes |
|---|---|---|---|
| `DRAFT` | `unsubmitted`, or missing/empty/`null` approval object | never occurs | Meta templates enter review on create. |
| `PENDING` | `received`, `pending` | `PENDING`, `IN_APPEAL` | `received` = at Twilio, not yet at Meta. |
| `APPROVED` | `approved` | `APPROVED`. Events `REINSTATED`/`UNARCHIVED`: re-fetch. `FLAGGED`: stay `APPROVED` (at risk) | Only `APPROVED` is sendable out-of-window. |
| `REJECTED` | `rejected` | `REJECTED`, `LIMIT_EXCEEDED` | `LIMIT_EXCEEDED` is a judgment call: not in review, not sendable, needs action. `rejectionReason` = Twilio `rejection_reason` / Meta `rejected_reason` (drop `NONE`) or webhook `reason` + `rejection_info.reason`. |
| `PAUSED` | `paused` | `PAUSED` | Temporary: 3h, then 6h. |
| `DISABLED` | `disabled` | `DISABLED`, `ARCHIVED` | `ARCHIVED` is a judgment call ("cannot be sent", recoverable for 28 days). |
| (remove row) | n/a | `DELETED`, `PENDING_DELETION` | Or hide. Not sendable. |
| fallback | any other value → `PENDING` + log raw | any other value → `PENDING` + log raw | `LOCKED` is edit-lock only, so there is no status change. |

| OCSO category | Twilio `category` | Meta `category` / `message_template_category` / `new_category` |
|---|---|---|
| `UTILITY` | `UTILITY`, legacy `TRANSACTIONAL` | `UTILITY` (legacy `TRANSACTIONAL`) |
| `MARKETING` | `MARKETING` | `MARKETING` |
| `AUTHENTICATION` | `AUTHENTICATION`, legacy `OTP` | `AUTHENTICATION` (legacy `OTP`) |
| `null` | `""` (unsubmitted) or unknown | `FREE_SERVICE`, other legacy tags, unknown |

Compare every value case-insensitively (Twilio events use lowercase).

## 11. Recorded example shapes (test fixtures)

These are anonymized. Field names and nesting follow the cited spec and doc examples exactly. The values are invented but valid (SIDs match `^HX[0-9a-f]{32}$`).

### 11.1 Twilio `GET /v1/ContentAndApprovals?PageSize=50` (spec-documented flat `approval_requests`)

```json
{
  "contents": [
    {
      "date_created": "2026-09-10T08:12:44Z",
      "date_updated": "2026-09-10T08:40:02Z",
      "sid": "HX0f0e72ce92eef937d6f481b338ecbd19",
      "account_sid": "AC380f1440015864f92677447480f1f528",
      "friendly_name": "order_ready_pickup",
      "language": "en",
      "variables": {"1": "Priya", "2": "A-10423"},
      "types": {
        "twilio/text": {"body": "Hi {{1}}, your order {{2}} is ready for pickup at the front desk. Reply STOP to opt out."}
      },
      "approval_requests": {
        "name": "order_ready_pickup",
        "category": "UTILITY",
        "content_type": "twilio/text",
        "status": "approved",
        "rejection_reason": "",
        "allow_category_change": true
      }
    },
    {
      "date_created": "2026-09-18T11:02:10Z",
      "date_updated": "2026-09-18T11:02:10Z",
      "sid": "HX4f797bbf4c5ea0aeb6bf52c4572d788f",
      "account_sid": "AC380f1440015864f92677447480f1f528",
      "friendly_name": "appointment_reminder",
      "language": "en",
      "variables": {"1": "Sam", "2": "Tuesday at 3pm"},
      "types": {
        "twilio/quick-reply": {
          "body": "Hi {{1}}, this is a reminder of your appointment on {{2}}. Can you make it?",
          "actions": [
            {"title": "Yes, confirm", "id": "appt_confirm"},
            {"title": "Reschedule", "id": "appt_reschedule"}
          ]
        }
      },
      "approval_requests": {
        "name": "appointment_reminder",
        "category": "UTILITY",
        "content_type": "twilio/quick-reply",
        "status": "pending",
        "rejection_reason": "",
        "allow_category_change": true
      }
    },
    {
      "date_created": "2026-09-19T14:30:00Z",
      "date_updated": "2026-09-19T14:41:27Z",
      "sid": "HXd44344fc2fada9cf545f9e4352636ec8",
      "account_sid": "AC380f1440015864f92677447480f1f528",
      "friendly_name": "invoice_ready",
      "language": "en",
      "variables": {"1": "invoices/INV-2291.pdf"},
      "types": {
        "twilio/media": {
          "body": "Your invoice is attached.",
          "media": ["https://files.example.com/{{1}}"]
        }
      },
      "approval_requests": {
        "name": "invoice_ready",
        "category": "UTILITY",
        "content_type": "twilio/media",
        "status": "rejected",
        "rejection_reason": "INVALID_FORMAT. Facebook is not able to create template with templateName=invoice_ready_hxd44344fc2fada9cf545f9e4352636ec8 due to the following error: Invalid parameter. More Details: Message template 'components' param is missing expected field(s). component of type HEADER is missing expected field(s) (example)",
        "allow_category_change": true
      }
    },
    {
      "date_created": "2026-09-21T09:15:31Z",
      "date_updated": "2026-09-21T09:15:31Z",
      "sid": "HX57def8125582d179373231006d5b2418",
      "account_sid": "AC380f1440015864f92677447480f1f528",
      "friendly_name": "welcome_back_draft",
      "language": "en",
      "variables": {},
      "types": {
        "twilio/text": {"body": "Welcome back! How can we help you today?"}
      },
      "approval_requests": {
        "name": "",
        "category": "",
        "content_type": "",
        "status": "unsubmitted",
        "rejection_reason": "",
        "allow_category_change": true
      }
    }
  ],
  "meta": {
    "page": 0,
    "page_size": 50,
    "first_page_url": "https://content.twilio.com/v1/ContentAndApprovals?PageSize=50&Page=0",
    "previous_page_url": null,
    "url": "https://content.twilio.com/v1/ContentAndApprovals?PageSize=50&Page=0",
    "next_page_url": "https://content.twilio.com/v1/ContentAndApprovals?PageSize=50&Page=1&PageToken=PAHX57def8125582d179373231006d5b2418",
    "key": "contents"
  }
}
```

Defensive-variant item for the channel-keyed shape observed in the wild (§2.1). Parse it identically:

```json
{"date_created":"2026-09-20T10:00:00Z","date_updated":"2026-09-20T10:05:00Z","sid":"HXf23dc31161b83909dff099feb03ea1b5","account_sid":"AC380f1440015864f92677447480f1f528","friendly_name":"delivery_delayed","language":"en","variables":{"1":"A-10424"},"types":{"twilio/text":{"body":"Your order {{1}} is delayed by a day. We are sorry for the wait."}},"approval_requests":{"whatsapp":{"type":"whatsapp","name":"delivery_delayed","category":"UTILITY","content_type":"twilio/text","status":"paused","rejection_reason":"","allow_category_change":true}}}
```

### 11.2 Twilio `POST /v1/Content` → 201

```json
{
  "sid": "HX4f797bbf4c5ea0aeb6bf52c4572d788f",
  "account_sid": "AC380f1440015864f92677447480f1f528",
  "friendly_name": "appointment_reminder",
  "language": "en",
  "variables": {"1": "Sam", "2": "Tuesday at 3pm"},
  "types": {
    "twilio/quick-reply": {
      "body": "Hi {{1}}, this is a reminder of your appointment on {{2}}. Can you make it?",
      "actions": [
        {"title": "Yes, confirm", "id": "appt_confirm"},
        {"title": "Reschedule", "id": "appt_reschedule"}
      ]
    }
  },
  "url": "https://content.twilio.com/v1/Content/HX4f797bbf4c5ea0aeb6bf52c4572d788f",
  "date_created": "2026-09-18T11:02:10Z",
  "date_updated": "2026-09-18T11:02:10Z",
  "links": {
    "approval_create": "https://content.twilio.com/v1/Content/HX4f797bbf4c5ea0aeb6bf52c4572d788f/ApprovalRequests/whatsapp",
    "approval_fetch": "https://content.twilio.com/v1/Content/HX4f797bbf4c5ea0aeb6bf52c4572d788f/ApprovalRequests"
  }
}
```

### 11.3 Twilio `POST /v1/Content/{sid}/ApprovalRequests/whatsapp` → 201

Request `{"name":"appointment_reminder","category":"UTILITY"}`. Response:

```json
{
  "name": "appointment_reminder",
  "category": "UTILITY",
  "content_type": "twilio/quick-reply",
  "status": "received",
  "rejection_reason": "",
  "allow_category_change": true
}
```

### 11.4 Twilio `GET /v1/Content/{sid}/ApprovalRequests` → 200

```json
{
  "sid": "HX4f797bbf4c5ea0aeb6bf52c4572d788f",
  "account_sid": "AC380f1440015864f92677447480f1f528",
  "whatsapp": {
    "type": "whatsapp",
    "name": "appointment_reminder",
    "category": "UTILITY",
    "content_type": "twilio/quick-reply",
    "status": "approved",
    "rejection_reason": "",
    "allow_category_change": true
  },
  "url": "https://content.twilio.com/v1/Content/HX4f797bbf4c5ea0aeb6bf52c4572d788f/ApprovalRequests"
}
```

### 11.5 Meta `GET /v26.0/{WABA-ID}/message_templates?fields=id,name,language,status,category,components,parameter_format,rejected_reason,quality_score&limit=4`

```json
{
  "data": [
    {
      "id": "1387372356726668",
      "name": "order_ready_pickup",
      "language": "en_US",
      "status": "APPROVED",
      "category": "UTILITY",
      "parameter_format": "POSITIONAL",
      "rejected_reason": "NONE",
      "quality_score": {"score": "GREEN", "date": 1758412800},
      "components": [
        {"type": "HEADER", "format": "TEXT", "text": "Order {{1}} is ready", "example": {"header_text": ["A-10423"]}},
        {"type": "BODY", "text": "Hi {{1}}, your order is ready for pickup at {{2}}. See you soon!", "example": {"body_text": [["Priya", "the front desk"]]}},
        {"type": "FOOTER", "text": "Reply STOP to opt out"},
        {"type": "BUTTONS", "buttons": [{"type": "QUICK_REPLY", "text": "On my way"}, {"type": "QUICK_REPLY", "text": "Need more time"}]}
      ]
    },
    {
      "id": "1625063511800527",
      "name": "booking_confirmation",
      "language": "en_US",
      "status": "APPROVED",
      "category": "UTILITY",
      "parameter_format": "NAMED",
      "rejected_reason": "NONE",
      "quality_score": {"score": "UNKNOWN", "date": 1758412800},
      "components": [
        {"type": "HEADER", "format": "IMAGE", "example": {"header_handle": ["https://scontent.whatsapp.net/v/t61.29466-34/sample.jpg"]}},
        {"type": "BODY", "text": "Thanks {{first_name}}! Your booking {{booking_ref}} is confirmed.", "example": {"body_text_named_params": [{"param_name": "first_name", "example": "Pablo"}, {"param_name": "booking_ref", "example": "BK-7781"}]}},
        {"type": "BUTTONS", "buttons": [{"type": "URL", "text": "View booking", "url": "https://example.com/bookings/{{1}}", "example": ["https://example.com/bookings/BK-7781"]}, {"type": "PHONE_NUMBER", "text": "Call us", "phone_number": "+15550051310"}]}
      ]
    },
    {
      "id": "1166414785519855",
      "name": "weekend_sale",
      "language": "en",
      "status": "REJECTED",
      "category": "MARKETING",
      "parameter_format": "POSITIONAL",
      "rejected_reason": "INVALID_FORMAT",
      "quality_score": {"score": "UNKNOWN", "date": 1758412800},
      "components": [
        {"type": "BODY", "text": "{{1}} {{2}} off this weekend", "example": {"body_text": [["Hi Sam", "20%"]]}}
      ]
    },
    {
      "id": "1304694804498707",
      "name": "cart_reminder",
      "language": "en",
      "status": "PAUSED",
      "category": "MARKETING",
      "parameter_format": "POSITIONAL",
      "rejected_reason": "NONE",
      "quality_score": {"score": "RED", "date": 1758499200},
      "components": [
        {"type": "BODY", "text": "You left {{1}} items in your cart. Complete your order today and get free delivery.", "example": {"body_text": [["3"]]}},
        {"type": "BUTTONS", "buttons": [{"type": "QUICK_REPLY", "text": "Unsubscribe"}]}
      ]
    }
  ],
  "paging": {
    "cursors": {"before": "QVFIUmxtbW9aT0hB", "after": "QVFIUkZAhNEtwUXRJ"},
    "next": "https://graph.facebook.com/v26.0/102290129340398/message_templates?fields=id%2Cname%2Clanguage%2Cstatus%2Ccategory%2Ccomponents%2Cparameter_format%2Crejected_reason%2Cquality_score&limit=4&after=QVFIUkZAhNEtwUXRJ"
  }
}
```

### 11.6 Meta `POST /v26.0/{WABA-ID}/message_templates` → 200

```json
{"id": "1689556908129832", "status": "PENDING", "category": "UTILITY"}
```

### 11.7 Meta webhooks

`message_template_status_update`: an APPROVED event, then a REJECTED event with `rejection_info`. Both are copied from the doc examples.

```json
{"entry":[{"id":"102290129340398","time":1751247548,"changes":[{"value":{"event":"APPROVED","message_template_id":1689556908129832,"message_template_name":"order_confirmation","message_template_language":"en-US","reason":"NONE","message_template_category":"UTILITY"},"field":"message_template_status_update"}]}],"object":"whatsapp_business_account"}
```

```json
{"entry":[{"id":"102290129340398","time":1751247548,"changes":[{"value":{"event":"REJECTED","message_template_id":1689556908129835,"message_template_name":"abandoned_cart","message_template_language":"en","reason":"INVALID_FORMAT","message_template_category":"MARKETING","rejection_info":{"reason":"Your template has parameters placed next to each other (like {{1}}{{2}}) without text or punctuation between them.","recommendation":"Separate parameters with descriptive text and ensure each parameter is clearly contextualized."}},"field":"message_template_status_update"}]}],"object":"whatsapp_business_account"}
```

PAUSED and DISABLED events. The fields are documented but these instances are constructed: `other_info` on a pause is inferred from the `TITLE` enum (§8).

```json
{"entry":[{"id":"102290129340398","time":1758499200,"changes":[{"value":{"event":"PAUSED","message_template_id":1304694804498707,"message_template_name":"cart_reminder","message_template_language":"en","reason":"NONE","message_template_category":"MARKETING","other_info":{"title":"FIRST_PAUSE","description":"Your WhatsApp message template has been paused for 3 hours."}},"field":"message_template_status_update"}]}],"object":"whatsapp_business_account"}
```

```json
{"entry":[{"id":"102290129340398","time":1758585600,"changes":[{"value":{"event":"DISABLED","message_template_id":1304694804498707,"message_template_name":"cart_reminder","message_template_language":"en","reason":"NONE","message_template_category":"MARKETING","disable_info":{"disable_date":1758585600}},"field":"message_template_status_update"}]}],"object":"whatsapp_business_account"}
```

`template_category_update` (completed change, copied from the doc):

```json
{"entry":[{"id":"102290129340398","time":1746169200,"changes":[{"field":"template_category_update","value":{"message_template_id":278077987957091,"message_template_name":"welcome_template","message_template_language":"en-US","previous_category":"UTILITY","new_category":"MARKETING"}}]}],"object":"whatsapp_business_account"}
```

## 12. What the implementation must be defensive about (UNVERIFIED or conflicting)

1. **Twilio `approval_requests` shape:** flat (spec) or `{whatsapp:{…}}` (seen in the wild), possibly an array. Accept all of them, and confirm via `/v1/Content/{sid}/ApprovalRequests` when it matters.
2. **Twilio statuses:** only 7 are documented. Unknown values map to `PENDING` and are logged. Values are lowercase in the API and in events.
3. **Twilio approval-create response:** `allow_category_change` and `send_ttl_seconds` may be absent. Don't send `allow_category_change` in the request.
4. **Twilio `GET …/ApprovalRequests` for a never-submitted SID:** could return 404, `whatsapp:null` or `whatsapp:{}`. Treat all as `unsubmitted`.
5. **Named Twilio variables in WhatsApp approval:** undocumented. Use numeric sequential keys for WhatsApp.
6. **Twilio `deleteInWaba`:** casing and placement are unconfirmed. Deleting a Twilio template may leave the WABA copy behind.
7. **Twilio limit conflicts:** quick-reply title is 20 or 25 chars, and id is 128 or 200. Use the stricter 20 and 128. Cap the body at 1024 for WhatsApp.
8. **Meta `message_template_id`:** an integer in webhooks and a string in REST. Coerce to a string.
9. **Meta webhook language:** `en-US` (hyphen) in the examples versus `en_US` in REST. Normalize `-`→`_` when matching.
10. **Meta enum casing:** creation examples send lowercase `category`/`parameter_format`/component `type`, while responses are uppercase. Compare case-insensitively.
11. **Meta `sub_category`:** a doc example shows `CUSTOM`, which is outside the enum. `button.index` is sometimes an integer in the examples. Accept loosely and send a string.
12. **Meta 404/803 for a missing template:** may really be 400/100. Treat both as not found.
13. **Meta `other_info` on pause:** the docs contradict themselves (lock/unlock only versus the pause `TITLE` enum). Make it optional.
14. **`LIMIT_EXCEEDED`→`REJECTED` and `ARCHIVED`→`DISABLED`** are OCSO judgment calls, not provider semantics.

## Sources

- https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_content_v1.json
- https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_content_v2.json
- https://github.com/twilio/twilio-node/blob/main/src/rest/content/v1/content.ts
- https://github.com/twilio/twilio-node/blob/main/src/rest/content/v1/contentAndApprovals.ts
- https://github.com/twilio/twilio-node/blob/main/src/rest/content/v1/content/approvalCreate.ts
- https://github.com/twilio/twilio-node/blob/main/src/rest/content/v1/content/approvalFetch.ts
- https://github.com/twilio/twilio-node/blob/main/src/base/Page.ts
- https://github.com/twilio/twilio-python/blob/main/twilio/rest/content/v1/content/approval_create.py
- https://www.twilio.com/docs/content/content-api-resources
- https://www.twilio.com/docs/content/content-types-overview
- https://www.twilio.com/docs/content/using-variables-with-content-api
- https://www.twilio.com/docs/content/twilio-text
- https://www.twilio.com/docs/content/twilio-media
- https://www.twilio.com/docs/content/twilio-quick-reply
- https://www.twilio.com/docs/content/twilio-call-to-action
- https://www.twilio.com/docs/content/create-and-send-your-first-content-api-template
- https://www.twilio.com/docs/whatsapp/tutorial/message-template-approvals-statuses
- https://www.twilio.com/docs/whatsapp/tutorial/send-whatsapp-notification-messages-templates
- https://www.twilio.com/docs/events/event-types/messaging/template-approval
- https://www.twilio.com/en-us/changelog/real-time-whatsapp-template-approval-and-category-updates-via-ev
- https://www.twilio.com/docs/api/errors/{63016,63027,63028,63040,63041,63042,63046}
- GitHub consumers of `approval_requests` (via `gh api search/code`): DiscipleTools/disciple-tools-channels-twilio `twilio-api/twilio-api.php`, susom/whats-app-alerts `classes/Template.php`, socialincome-san/public `…/twilio-template.service.ts`, rhernandezbas/ipnext-backend `…/TwilioContentGateway.ts`, David-Sousa-Web/Bizap `…/list-templates.service.ts`, roberto-alarcon-seo/notyfive-app-realstate `supabase/functions/sync-template-status/index.ts`, sanyagouan/cerebro-en-las-nubes `scripts/check_approval_status_v2.py`, Odoo-KRD/odookrd-platform `…/twilio-whatsapp.client.ts`
- https://github.com/facebook/openapi/blob/main/business-messaging-api_v23.0.yaml
- https://developers.facebook.com/documentation/business-messaging/whatsapp/llms.txt
- https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/message-template-api.md
- https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api.md
- https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview.md
- https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/components.md
- https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-management.md
- https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-pausing.md
- https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-archival.md
- https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_status_update.md
- https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/template_category_update.md
- https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_quality_update.md
- https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes.md
- https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/message_templates/
- https://developers.facebook.com/docs/graph-api/reference/whats-app-business-hsm/
- https://developers.facebook.com/docs/graph-api/changelog/
