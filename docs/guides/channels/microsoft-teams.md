# Microsoft Teams

This guide connects an Azure Bot in Microsoft Teams to OCSO, as the `MS_TEAMS` channel kind (label **Microsoft
Teams**). People chat with the bot one to one, or @mention it in a group chat or a team channel. The Bot Connector
posts each activity to the channel's webhook, signed with Microsoft's keys, and OCSO answers in the same chat or
channel thread. It is for the Tech admin who sets the channel up.

A Teams channel serves either customers (through a router and an AI agent) or your own staff (Ask OCSO). This page
covers the setup both share; for the staff side see [Ask OCSO in Slack and Teams](ask-ocso-in-slack-and-teams.md).

The adapter is in [packages/channels/src/teams/](../../../packages/channels/src/teams/). The setup steps below are the
ones OCSO shows in the channel dialog, from [descriptor.ts](../../../packages/channels/src/teams/descriptor.ts).

> [!NOTE]
> The Teams adapter is tested offline, with signed Bot Framework-shaped fixtures and local stubs of Microsoft's
> endpoints (`apps/api/test/int/ms-teams-channel.int.test.ts`). The repository records no run against a live
> Microsoft 365 tenant.

## Prerequisites

- **Azure rights.** You can create an Azure Bot resource in a subscription and resource group, and an app
  registration in Microsoft Entra ID (the bot creates one if you may register apps).
- **Teams rights.** Your organization allows custom app upload for you, or a Teams admin approves the app in the
  Teams admin center.
- **A public https origin.** Azure Bot Service only calls public https endpoints. `OCSO_PUBLIC_URL` must be the
  https origin Microsoft can reach.
- **OCSO rights.** A Tech admin (`channels.manage`) creates the channel; a Head (`approvals.check.channels`) approves
  its activation.
- **A reminder for the client secret's expiry.** The bot stops answering when it lapses.

## Set it up

1. **Create the draft.** Open **Integrations → Channels → Add channel**, choose **Microsoft Teams**, enter a **Name**
   and choose **Create draft and continue**. The webhook URL exists before you configure Azure:

   ```text
   https://<your OCSO host>/channels/ms-teams/<publicKey>/webhook
   ```

2. **Create an Azure Bot.** In the Azure portal choose **Create a resource → Azure Bot**:
   - **Bot handle**: any unique name (people do not see it in Teams);
   - **Type of App**: **Single Tenant** (recommended: only people in your Microsoft 365 tenant can reach it), or
     **Multi Tenant** only if people from other organizations must;
   - **Creation type**: **Create new Microsoft App ID**;
   - **Pricing tier**: Standard channels such as Teams are free.

   Check: the deployment finishes and the Azure Bot resource opens.
3. **Record the Microsoft App ID and the Tenant ID.** On the bot's **Configuration** page choose **Manage Password**
   next to the Microsoft App ID. The app registration's **Overview** shows the **Application (client) ID** (the
   Microsoft App ID) and the **Directory (tenant) ID** (needed for a Single Tenant bot).
4. **Create a client secret.** In the app registration open **Certificates & secrets → Client secrets → New client
   secret**. Copy the **Value**, not the Secret ID, right away: Azure shows it once. Note the expiry date.
5. **Set the messaging endpoint.** On the Azure Bot open **Configuration** and set **Messaging endpoint** to the
   channel's webhook URL, then **Apply**.
6. **Add the Microsoft Teams channel.** On the Azure Bot open **Channels**, choose **Microsoft Teams**, accept the terms
   and **Apply**. Check: Microsoft Teams is listed with status **Healthy**.
7. **Paste the values into OCSO and save.** In the form inside this step enter **Microsoft App ID**, **App type**,
   **Tenant ID** and **Client secret**, and save. The client secret is write-only.
8. **Download the Teams app package and upload it.** The step offers **Teams app package** (`ocso-teams-app.zip`).
   It needs the saved App ID, so save first. In Teams choose **Apps → Manage your apps → Upload an app → Upload a
   custom app** and pick the zip. If custom apps are blocked, choose **Submit an app to your org**; a Teams admin
   approves it in the Teams admin center (**Teams apps → Manage apps**). A Teams admin can also upload it there to
   make it available to everyone.
9. **Test.** Choose **Test connection**, then **Activate** (a Head approves it). Once live, open the app in Teams and
   send it a message; in group chats and channels, @mention it. Check: the assistant replies, and the card shows the
   last inbound time.
10. **For customers, attach it to a router** under **Routers**. For staff, set **Destination** to `ask_ocso`; no router
    is needed.

### Test connection

**Test connection** never posts a message. It reports:

- **App credentials**: a Bot Connector token from Microsoft Entra (client-credentials grant). When Entra refuses, the
  check names the likely cause: wrong or expired secret, app not in the tenant, single/multi-tenant mismatch.
- **Signing keys**: Microsoft's Bot Framework signing keys can be fetched.
- **Messaging endpoint**: the webhook URL is https.

### The app package

OCSO builds the zip on the server from the saved channel: `GET /v1/channels/:id/setup-files/teams-app-package`
(`channels.read`). Until the App ID is saved it answers `400 setup_file_incomplete`. It never contains the client
secret. It holds:

- `manifest.json`, schema **1.30**: the app `id` and the bot's `botId` are the Microsoft App ID; bot scopes
  `personal`, `team` and `groupChat`; `supportsFiles: false`; `validDomains` and the developer links use the OCSO
  host;
- `color.png` (192×192) and `outline.png` (32×32, white on transparent).

The app is named **OCSO Assistant**.

## Settings

| Setting (form label) | Default | Meaning |
|---|---|---|
| `destination` (Destination) | `router` | `router`: customers, routed like any channel. `ask_ocso`: your staff use Ask OCSO here. Added by OCSO. |
| `appId` (Microsoft App ID) | required | The app registration's Application (client) ID, a GUID. |
| `appType` (App type) | `SingleTenant` | `SingleTenant` or `MultiTenant`, as chosen when the bot was created. |
| `tenantId` (Tenant ID) | none | Directory (tenant) ID. Required for a single-tenant bot. |
| `cloud` (Microsoft cloud) | `public` | `public` (commercial Microsoft 365) or `usgov` (GCC, GCC High, DoD). Picks the login host, token issuer, signing keys and allowed Bot Connector hosts. |
| `requestTimeoutMs` (Request timeout (ms)) | `15000` | One Microsoft call (token, signing keys, Bot Connector). |
| `retries` (Retries) | `2` | Retries after HTTP 429 or 5xx from the Bot Connector inside one send. |
| `maxRetryAfterSeconds` (Longest in-place wait (s)) | `10` | A longer wait goes back to the outbox backoff. |
| `endpoints` (Endpoints (tests only)) | none | OpenID metadata URL, token URL and extra service URL hosts, for a local stub. Only loopback values (`localhost`, `127.0.0.1`, `[::1]`) are accepted. Leave empty in production. |

| Secret (form label) | Meaning |
|---|---|
| `appPassword` (Client secret) | The client secret's **Value**. No whitespace. |

## How it behaves

- **Verification.** Every activity must carry `Authorization: Bearer <JWT>` from the Bot Connector. OCSO checks it
  against the Bot Framework OpenID metadata: RS256, a published key endorsed for `msteams`, issuer
  `https://api.botframework.com`, audience = the App ID, not expired (5 minutes skew), and a `serviceurl` claim equal
  to the activity's `serviceUrl`, which must be a Bot Connector host. Missing or expired tokens get `401`; forged
  tokens, other bots' tokens and mismatched service URLs get `403`. If the keys cannot be fetched the webhook answers
  `502` and the connector retries.
- **Inbound.** `message` activities from personal chats, and from group chats or channels where the bot is
  @mentioned. The bot's own mention is removed. Other activity types, other Bot Framework channels (such as the Azure
  portal's Web Chat test) and, for a single-tenant bot, other tenants are acknowledged and ignored. The customer
  identity is `teams_user`, value `<tenant id>:<Entra object id>`.
- **Where replies go.** Each inbound message records its conversation reference. A reply lands where the message it
  answers came from: the personal chat, the group chat, or the channel thread.
- **Outbound.** Teams markdown; headings become bold lines. Text is split at 7,000 characters.
- **SSRF guard.** OCSO sends its bearer token only to an https Bot Connector host of the configured cloud
  (`smba.trafficmanager.net` and `*.botframework.com` for the public cloud).
- **Tokens** are cached until five minutes before they expire, per App ID and secret, so a rotated secret gets a new
  token.

### Choice questions

A router's choice question becomes an Adaptive Card (version 1.4): up to 6 options as `Action.Submit` buttons, 7 to
10 as a drop-down with a **Send** button. A tap comes back as a `button_reply` with the option id. Each button carries
the Entra object id of the person asked; a tap by anyone else in the chat is ignored.

## Verify it works

1. **Test connection** shows three passing checks.
2. After activation (and a router, for customers), send the app a message in a personal chat. The card shows "last
   inbound … ago"; for customers the conversation appears with the `MT` badge.
3. @mention the bot in a team channel where the app was added; the reply lands in that thread.

## Troubleshooting

| Problem | Fix |
|---|---|
| Messages are refused with 401, or Test connection cannot get a token | Check that **Microsoft App ID** is the Application (client) ID, **Tenant ID** the Directory (tenant) ID, and that **App type** matches how the Azure Bot was created. |
| `AADSTS7000215`: invalid client secret | Paste the secret's **Value**, not its Secret ID, or create a new secret. |
| `AADSTS7000222`: the client secret expired | Create a new client secret and paste its Value. On a live channel the change is a proposal, so rotate before the expiry date. |
| Teams does not offer **Upload a custom app** | Custom app upload is blocked. Choose **Submit an app to your org**, or ask a Teams admin to allow custom apps in a setup policy. |
| No reply in a team channel or group chat | The bot only receives messages that @mention it there. In a team channel the app must be added to the team. |
| Test connection says the messaging endpoint is not https | Set `OCSO_PUBLIC_URL` to the https origin Microsoft can reach, restart OCSO, and use the new webhook URL. |
| The package download says `setup_file_incomplete` | Save the **Microsoft App ID** on the channel first. |
| Customer messages are rejected with `no_router` | Attach the channel to an active router, or set **Destination** to `ask_ocso` for staff. |

## Limits and known gaps

- **Text and choice cards only.** Attachments are not imported (Teams files need the file consent flow or SharePoint
  links); OCSO sends no files.
- **No proactive messages.** OCSO answers only in chats people start. A message meant for one person with no reply
  context (for example Ask OCSO's account link) goes to the personal chat that person last used with the bot, as the
  running process last saw it (kept in memory for a day); with none known, the send fails.
- **No delivery receipts.** Messages stay `SENT`.
- **Sent cards are not updated** after a tap.
- **One audience per channel**: customers or staff.
- Not verified against a live tenant.

## Related

- [Channels overview](README.md)
- [Ask OCSO in Slack and Teams](ask-ocso-in-slack-and-teams.md)
- [Slack](slack.md)
- [Routing](../../concepts/routing.md)
- [Alerts and webhooks](../alerts-and-webhooks.md): Teams as an alert destination is separate from this channel
