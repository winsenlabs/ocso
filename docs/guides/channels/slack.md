# Slack

This guide connects a Slack app to OCSO, as the `SLACK` channel kind. People send the app a direct message or
@mention it in a channel; Slack posts those events, and button clicks, to the channel's webhook. Replies go back with
the bot token: in the DM, or in a thread under the mention. It is for the Tech admin who sets the channel up.

A Slack channel serves either customers (through a router and an AI agent) or your own staff (Ask OCSO). This page
covers the setup both share; for the staff side see [Ask OCSO in Slack and Teams](ask-ocso-in-slack-and-teams.md).

The adapter is in [packages/channels/src/slack/](../../../packages/channels/src/slack/). The setup steps below are the
ones OCSO shows in the channel dialog, from
[descriptor.ts](../../../packages/channels/src/slack/descriptor.ts).

![The Slack setup guide in the channel dialog](../../assets/screens/slack-setup-guide.webp)

> [!NOTE]
> The Slack adapter is tested offline, with signed Slack-shaped fixtures and a fake Slack Web API
> (`apps/api/test/int/slack-channel.int.test.ts`). The repository records no run against a live Slack workspace.

## Prerequisites

- **Slack rights.** You can create and install apps in the workspace. If installs are restricted, a workspace admin
  approves the request. On Enterprise Grid an org admin may also need to approve the app and add it to the
  workspace.
- **A public https origin.** Slack only calls public https URLs. `OCSO_PUBLIC_URL` must be the https origin Slack
  can reach.
- **OCSO rights.** A Tech admin (`channels.manage`) creates the channel; a Head (`approvals.check.channels`) approves
  its activation.
- **Somewhere safe for two secrets.** The bot token and the signing secret go only into OCSO's form.

## Set it up

1. **Create the draft.** Open **Integrations → Channels → Add channel**, choose **Slack**, enter a **Name** and choose
   **Create draft and continue**. OCSO saves a draft with only the name, so the webhook URL exists before the Slack
   app does:

   ```text
   https://<your OCSO host>/channels/slack/<publicKey>/webhook
   ```

   The dialog now shows the guide below as a checklist. Close it at any time and come back with **Edit**.
2. **Create the Slack app from the manifest.** The step offers the manifest as **Slack app manifest (YAML)** and
   **Slack app manifest (JSON)**, with **Copy** and **Download**, and this channel's webhook URL already filled in.
   At [api.slack.com/apps](https://api.slack.com/apps) choose **Create New App → From an app manifest**, pick the
   workspace, paste the manifest (YAML or JSON tab) and create the app. You can rename the app and the bot first.
   Slack may say the Request URL is not verified yet; that is expected until step 7.
3. **Review the bot token scopes** under **OAuth & Permissions → Scopes → Bot Token Scopes** (table below). If you
   change scopes later, reinstall the app or Slack keeps the old grant.
4. **Install the app to your workspace** (**Install App** or **OAuth & Permissions → Install to Workspace**). Check:
   OAuth & Permissions shows a **Bot User OAuth Token** (`xoxb-…`).
5. **Copy the bot token and the signing secret**: the Bot User OAuth Token from **OAuth & Permissions → OAuth
   Tokens**, and the **Signing Secret** from **Basic Information → App Credentials** (**Show**).
6. **Paste them into OCSO and save.** Enter **Bot token** and **Signing secret** in the form inside this step, choose
   **Respond to** (DMs, @mentions or both) and save. Secrets are write-only. Check: the channel card lists
   `botToken, signingSecret set`.
7. **Verify the Request URL under Event Subscriptions.** Once the signing secret is saved, OCSO answers Slack's
   signed `url_verification` challenge, even while the channel is a draft. If the Request URL shows as not verified,
   choose **Retry**. Subscribed bot events: `app_mention` and `message.im`. Check: **Verified**.
8. **Check Interactivity.** Under **Interactivity & Shortcuts**, Interactivity is on with the same Request URL.
   Button taps arrive there.
9. **Allow messages in App Home.** Under **App Home → Show Tabs**, turn on the **Messages Tab** and check "Allow users
   to send Slash commands and messages from the messages tab". Without it people cannot DM the app.
10. **Invite the bot to channels** where it should answer @mentions: `/invite @ocso-assistant` (or your bot's name).
    DMs need no invite. To limit which channels are answered, list their ids under **Allowed channels**.
11. **Test.** Choose **Test connection**, then **Activate** (a Head approves it). Once live, send the app a DM.
    Check: the assistant replies, and the card shows the last inbound time.
12. **For customers, attach it to a router** under **Routers**. For staff, set **Destination** to `ask_ocso`
    instead; no router is needed.

### Test connection

**Test connection** never posts a message. It reports:

- **Bot token**: `auth.test` succeeds, for which workspace and bot user. A user token (`xoxp-`) or a token that is
  not a bot's is refused.
- **Bot scopes**: every required scope is granted. A missing required scope fails the check; a missing optional
  scope is only noted.
- **Request URL**: the webhook URL is https.

### The manifest

The manifest ([`SLACK_APP_MANIFEST`](../../../packages/channels/src/slack/descriptor.ts)) sets:

- `display_information.name` `OCSO Assistant`, a bot user `ocso-assistant` (Slack allows only `a-z`, `0-9`, `-`, `_`
  and `.` in its display name), always online;
- `app_home` with the Messages tab on and `messages_tab_read_only_enabled: false`;
- the bot scopes below;
- `event_subscriptions` with `request_url` = the webhook URL and bot events `app_mention`, `message.im`;
- `interactivity` on, same `request_url`;
- `org_deploy_enabled`, `socket_mode_enabled` and `token_rotation_enabled` all `false`.

The files are also available from the API: `GET /v1/channels/:id/setup-files/slack-app-manifest-yaml` and
`GET /v1/channels/:id/setup-files/slack-app-manifest` (JSON), with `channels.read`. Only the webhook URL is filled
in; no secret is ever put in a setup file.

| Scope | Required | Why OCSO needs it |
|---|---|---|
| `chat:write` | yes | Post replies (`chat.postMessage`) in DMs and in threads under @mentions. |
| `im:history` | yes | Receive DMs to the app (`message.im`). |
| `app_mentions:read` | yes | Receive @mentions in channels (`app_mention`). |
| `users:read` | no | Read the writer's profile. Not called yet; requested so profile lookups work later without a reinstall. |
| `users:read.email` | no | Read the writer's email, to match Slack users to OCSO users. Not called yet either. |

## Settings

| Setting (form label) | Default | Meaning |
|---|---|---|
| `destination` (Destination) | `router` | `router`: people who message the app are customers, routed like any channel. `ask_ocso`: your staff use Ask OCSO here. Added by OCSO to every staff-destination kind. |
| `respondTo` (Respond to) | `dm_and_mentions` | `dm`, `mentions` or `dm_and_mentions`. |
| `replyInThread` (Reply in thread) | `true` | Answer an @mention in a thread under it, or in the channel itself. A message already in a thread is always answered there. |
| `allowedChannelIds` (Allowed channels) | `[]` | Up to 200 channel ids (`C…`, `G…`) where @mentions are answered. Empty = every channel the app is in. DMs are not affected. |
| `apiBaseUrl` (API base URL) | `https://slack.com/api` | Override only for tests or an egress proxy. |
| `requestTimeoutMs` (Request timeout (ms)) | `10000` | One Slack API call. |
| `rateLimitRetries` (Rate-limit retries) | `2` | Retries after HTTP 429 inside one send, each after Slack's `Retry-After`. |
| `maxRetryAfterSeconds` (Longest in-place wait (s)) | `10` | A longer `Retry-After` goes back to the outbox backoff. |

| Secret (form label) | Format |
|---|---|
| `botToken` (Bot token) | `xoxb-…`. User (`xoxp-`) and refresh (`xoxe`) tokens are refused. |
| `signingSecret` (Signing secret) | 16 to 128 letters and digits. |

## How it behaves

- **Verification.** Every request must carry a valid `X-Slack-Signature`: HMAC-SHA256 of `v0:{timestamp}:{raw body}`
  with the signing secret, compared in constant time, with a timestamp within 5 minutes.
- **Inbound.** DMs to the app and `app_mention` events, as far as **Respond to** and **Allowed channels** allow. Bot
  messages (including its own), edits, deletions and joins are ignored. The app's own mention is removed. `event_id`
  is the idempotency key, so Slack's retries are dropped. The customer identity is `slack_user`, value
  `<team_id>:<user_id>`.
- **Where replies go.** Each inbound message records a reply context (`teamId`, `channel`, `threadTs`). A reply goes
  where the message it answers came from, so a DM answer stays in the DM even if the person @mentions the app
  elsewhere meanwhile. With no context, OCSO posts to the person's DM.
- **Outbound.** Markdown becomes Slack mrkdwn. Only http(s) and mailto links become links; anything else is plain
  text, so agent output cannot ping `@channel`, `@here`, `@everyone`, users or groups. Unfurls are off. Text is
  split at 40,000 characters.
- **Rate limits and errors.** HTTP 429 waits for `Retry-After` in place (see the settings); auth, scope and "channel
  not found" errors fail without retrying; 5xx and network errors are retried.

### Choice questions

A router's choice question becomes a Block Kit section with up to 25 buttons. Each button's `action_id` is
`ocso.choice:<option id>`, and the actions block names the person asked; a click by anyone else is ignored. A click
comes back as a `button_reply` with the option id. If the labels would be ambiguous, OCSO sends the numbered text.

## Verify it works

1. **Test connection** shows three passing checks.
2. After activation (and a router, for customers), DM the app. The card shows "last inbound … ago"; for customers the
   conversation appears with the `SL` badge.
3. @mention the app in a channel it was invited to; the reply lands in a thread under the mention.

## Troubleshooting

| Problem | Fix |
|---|---|
| Event Subscriptions says the Request URL is not verified | Save the channel with the signing secret first, then **Retry** in Slack. The URL must be exactly the webhook URL shown, on an https `OCSO_PUBLIC_URL`. |
| Replies to @mentions fail with `not_in_channel` | `/invite @your-bot` in that channel, then mention it again. |
| `missing_scope`, or Test connection lists a missing scope | Add the scope under **OAuth & Permissions → Bot Token Scopes** (or re-paste the manifest), then reinstall the app. Paste the new bot token if it changed. |
| DMs never arrive | Turn on **App Home → Messages Tab** and "Allow users to send Slash commands and messages from the messages tab". Check `im:history` and `message.im` (reinstall after changes) and that **Respond to** includes DMs. |
| Everything is refused after the signing secret was regenerated | Paste the new **Signing Secret** and save. On a live channel the change is a proposal, so rotate when a checker is available. |
| Test connection says Slack rejected the bot token | The app was uninstalled or the token revoked. Reinstall and paste the new `xoxb-…` token. |
| Enterprise Grid: a workspace cannot use the app | An org admin adds the app to each workspace. The manifest keeps org-wide deployment off. |
| Test connection says the Request URL is not https | Set `OCSO_PUBLIC_URL` to the https origin Slack can reach, restart OCSO, and use the webhook URL it then shows. |
| Customer messages are rejected with `no_router` | Attach the channel to an active router, or set **Destination** to `ask_ocso` if it is for staff. |

## Limits and known gaps

- **Text and choice buttons only.** Files people share are not imported (only the text is read), and OCSO sends no
  files: that would need `files:write` and Slack's two-step upload.
- **No delivery receipts.** Messages stay `SENT`.
- **No display-name lookups.** `users.info` is not called; the inbox shows the profile name when the event carries
  one, otherwise the Slack user id.
- **One audience per channel.** A Slack channel serves customers or staff, not both.
- Not verified against a live workspace.

## Related

- [Channels overview](README.md)
- [Ask OCSO in Slack and Teams](ask-ocso-in-slack-and-teams.md)
- [Microsoft Teams](microsoft-teams.md)
- [Routing](../../concepts/routing.md)
- [Alerts and webhooks](../alerts-and-webhooks.md): Slack as an alert destination is separate from this channel
