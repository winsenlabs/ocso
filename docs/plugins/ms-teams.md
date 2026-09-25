# Microsoft Teams channel

The `MS_TEAMS` channel kind connects OCSO to an Azure Bot in Microsoft Teams. People chat with the bot
one to one, or @mention it in a group chat or a team channel. The Bot Connector posts each activity to
the channel's webhook, signed with Microsoft's keys. The AI agent's replies go back through the Bot
Connector REST API, into the same chat or channel thread. The code is in
`packages/channels/src/teams/`.

## Before you start

- **Azure rights.** You need to create an Azure Bot resource in a subscription and resource group,
  and an app registration in Microsoft Entra ID (the bot creates one for you if you may register apps).
- **Teams rights.** Your organization must allow custom app upload for you, or a Teams admin approves
  the app in the Teams admin center.
- **A public https origin.** Azure Bot Service only calls public https endpoints. `OCSO_PUBLIC_URL`
  must be the https origin Microsoft can reach; the webhook URL OCSO shows is built from it.
- **OCSO rights.** Adding the channel needs `channels.manage` (a Tech admin). Activating it needs a
  second person who can approve channels.
- **A reminder for the client secret's expiry.** The bot stops answering when it lapses.

## Set it up

OCSO walks you through these steps in the channel dialog (**Integrations → Channels → Add channel →
Microsoft Teams**). The dialog first saves a **draft** with just the name, so the webhook URL exists
before you configure Azure. A draft is inert until its activation is approved, and may stay
incomplete until then; any value you do enter is still checked. Come back to it with **Edit**.

1. **Create an Azure Bot** (Azure portal → Create a resource → Azure Bot): any bot handle, type
   **Single Tenant** (recommended: only your tenant can reach it; Multi Tenant only if other
   organizations must), creation type **Create new Microsoft App ID**.
2. **Record the Microsoft App ID and Tenant ID**: Configuration → Manage Password opens the app
   registration; its Overview shows the Application (client) ID and the Directory (tenant) ID.
3. **Create a client secret** (Certificates & secrets → New client secret). Copy the **Value**, not
   the Secret ID. Note the expiry and rotate before it lapses.
4. **Set the messaging endpoint** (Azure Bot → Configuration) to the channel's webhook URL
   (`/channels/ms-teams/<publicKey>/webhook`, shown with a Copy button).
5. **Add the Microsoft Teams channel** (Azure Bot → Channels) and accept the terms.
6. **Paste the values into OCSO and save**: App ID, app type, tenant ID and the client secret (the
   form sits in this step of the guide). Secrets are write-only.
7. **Download the Teams app package and upload it** in Teams: **Apps → Manage your apps → Upload an
   app → Upload a custom app**. If custom apps are blocked, choose **Submit an app to your org** and a
   Teams admin approves it in the Teams admin center.
8. **Test.** **Test connection** requests a Bot Connector token (and names the likely cause when
   Microsoft Entra refuses: wrong secret, expired secret, app not in the tenant, single/multi-tenant
   mismatch), fetches Microsoft's signing keys and checks that the endpoint is https. It never posts a
   message. Then activate the channel (a second person approves), open the app in Teams and send it a
   message.

### The app package

OCSO builds the zip on the server from the saved channel
(`GET /v1/channels/:id/setup-files/teams-app-package`, `channels.read`). It is ready once the App ID is
saved (before that the download answers `400 setup_file_incomplete`) and never contains the client
secret. It holds:

- `manifest.json`, schema **1.30**: the app `id` and the bot's `botId` are the Microsoft App ID; bot
  scopes `personal`, `team` and `groupChat`; `validDomains` and the developer links use the OCSO host.
- `color.png`, 192×192: the Route mark on its dark tile.
- `outline.png`, 32×32: the mark in white on transparent, as Teams requires.

## Troubleshooting

| Problem | Fix |
|---|---|
| 401s, or no token in Test connection | Check the App ID (Application (client) ID), the Tenant ID (Directory (tenant) ID) and that **App type** matches how the Azure Bot was created. |
| `AADSTS7000215` invalid client secret | Paste the secret's Value, not its Secret ID, or create a new secret. |
| `AADSTS7000222` expired secret | Create a new client secret and paste it. On a live channel the change needs approval, so rotate early. |
| No "Upload a custom app" in Teams | Custom apps are blocked by policy: submit the app to your org, or ask a Teams admin to allow custom apps. |
| No reply in a channel or group chat | The bot only receives messages that @mention it there. In a team channel the app must be added to the team. |
| Endpoint not https | Set `OCSO_PUBLIC_URL` to a public https origin, restart, and use the new webhook URL. |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `appId` | (required) | The Azure Bot's Microsoft App ID (the app registration's client id). |
| `appType` | `SingleTenant` | `SingleTenant` or `MultiTenant`, as chosen when the bot was created. |
| `tenantId` | | The app registration's directory (tenant) id. Required for a single-tenant bot. |
| `cloud` | `public` | `public` (commercial Microsoft 365) or `usgov` (GCC, GCC High, DoD). It picks the login host, the token issuer, the signing keys and the allowed Bot Connector hosts. |
| `requestTimeoutMs` | `15000` | How long one Microsoft call may take. |
| `retries` | `2` | Retries of HTTP 429 and 5xx from the Bot Connector inside one send. |
| `maxRetryAfterSeconds` | `10` | A longer wait goes back to the outbox backoff. |
| `endpoints` | | Test overrides only (OpenID metadata URL, token URL, extra Bot Connector hosts), and only loopback URLs and hosts (`localhost`, `127.0.0.1`, `[::1]`) are accepted: they decide who may sign inbound tokens and where the app password and bearer token go, which no channel setting may point elsewhere. Leave empty in production. |

## How it behaves

- **Verification.** Every activity must carry `Authorization: Bearer <JWT>` from the Bot Connector.
  OCSO checks it against the Bot Framework OpenID metadata
  (`https://login.botframework.com/v1/.well-known/openidconfiguration` → `jwks_uri`): RS256, a
  published key (and, when the key lists endorsements, one endorsed for `msteams`), issuer
  `https://api.botframework.com`, audience = the App ID, not expired (5 minutes clock skew), and a
  `serviceurl` claim equal to the activity's `serviceUrl`. That service URL must also be a Bot Connector
  host (below). Missing or expired tokens get `401`; forged tokens, other bots' tokens and mismatched
  service URLs get `403`. Keys are cached for 12 hours; an unknown `kid` refreshes them at most once
  every 5 minutes. If the keys cannot be fetched the webhook answers `502` and the Bot Connector
  retries. Keys and tokens are fetched through the guarded channel egress. Accepted activities get an
  empty `200`.
- **Inbound.** OCSO handles `message` activities from Teams: personal chats, and group chats or
  channels where the bot is @mentioned (Teams only delivers those). The bot's own mention is removed;
  other mentions become `@Name`, and light HTML becomes text. `conversationUpdate`, `typing`,
  reactions, `invoke`, installation updates, other Bot Framework channels (such as the Azure portal's
  Web Chat test) and, for a single-tenant bot, other tenants are acknowledged and ignored. The
  idempotency key is the activity id scoped to its conversation, so connector retries are dropped as
  duplicates. The customer identity is `teams_user` with the value `<tenant id>:<Entra object id>`.
  Lists show `Teams · …` and the last six characters of the object id.
- **Where replies go.** Each inbound message records its conversation reference as the reply context:
  `{ serviceUrl, conversationId, conversationType, tenantId, botId }`. It names the conversation, not
  the message, so the same chat or channel thread gives the same context each time (Ask OCSO keeps one
  thread per chat thread on it). A reply is a new message where the message it answers came from: the
  personal chat, the group chat, or the channel thread (a channel conversation id carries
  `;messageid=<root>`, so the post lands in that thread). An agent reply uses the latest reference up
  to its turn's input, so a personal answer stays personal even if the person @mentions the bot in a
  channel while the turn runs.
- **Sends with no reply context** are meant for the person alone (for example Ask OCSO's one-time
  account link). They go to the personal chat that person last used with the bot on this channel, as
  the running OCSO process last saw it (kept in memory for a day), and never to a group chat or
  channel. With none known the send fails without retrying: a bot can only start a Teams chat through
  proactive installation, which v1 does not do. Ask OCSO then answers in the shared chat with a note
  to message the bot 1:1, never with the link.
- **SSRF guard.** OCSO sends its bearer token only to an https Bot Connector host of the configured
  cloud: `smba.trafficmanager.net` and `*.botframework.com` for the public cloud (not
  `*.trafficmanager.net`: any Azure customer can create a name there); the US Government hosts only when `cloud` is `usgov`. The service URL is checked when the
  activity is verified and again right before each send.
- **Tokens.** Bot → connector tokens come from Microsoft Entra with the client-credentials grant
  (`<login host>/<tenant id or botframework.com>/oauth2/v2.0/token`, scope
  `https://api.botframework.com/.default`). They are cached until five minutes before they expire,
  per app ID and secret, so a rotated secret gets a new token. Concurrent sends share one request.
  A `401` from the connector drops the cached token and retries once with a fresh one.
- **Outbound.** Text is sent as Teams markdown (`textFormat: markdown`). Headings become bold lines;
  emphasis, lists, links and code are sent as they are. Text is split at 7,000 characters.
- **Choice questions.** A router's choice question becomes an Adaptive Card (1.4): up to 6 options as
  `Action.Submit` buttons, 7 to 10 as a drop-down with a Send button. A tap comes back as a message
  activity whose `value` is the button's data and becomes a `STRUCTURED` `button_reply` part with
  `data.id` set to the option id, the same shape as WhatsApp, web chat and Slack. Each button carries
  the Entra object id of the person asked; a tap by anyone else in the chat is ignored.
- **Rate limits and errors.** HTTP 429 and 5xx are retried in place (`Retry-After`, or 1 s then 2 s)
  up to `retries`, as long as the wait is at most `maxRetryAfterSeconds`; then the outbox backs off.
  `ConversationNotFound`, `BotNotInConversationRoster` and `404` fail as undeliverable; `400`/`413`
  as invalid requests; refused app credentials as `auth_failed`. None of these are retried. Network
  errors and timeouts are retried by the outbox (the connector may have accepted the message, so a
  duplicate is possible).

## Not in v1

- **Files.** Attachments are not imported (Teams files need the file consent flow or SharePoint
  links); only the text of a message is read. OCSO does not send files.
- **Proactive messages.** OCSO only answers in chats people start with the bot.
- **Delivery receipts.** The Bot Connector has none. Messages stay `SENT`.
- **Message updates.** Sent cards are not updated after a tap.
