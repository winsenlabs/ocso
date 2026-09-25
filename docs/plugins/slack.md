# Slack channel

The `SLACK` channel kind connects OCSO to a Slack app. People send the app a direct message or
@mention it in a channel. Slack posts those events, plus button clicks, to the channel's webhook. The
AI agent's replies go back with the bot token: in the DM, or in a thread under the mention. The code
is in `packages/channels/src/slack/`.

## Before you start

- **Slack rights.** You need permission to create and install apps in the workspace. If the workspace
  restricts installs, a workspace admin approves the request. On Enterprise Grid, an org admin may
  also need to approve the app and add it to the workspace.
- **A public https origin.** Slack only calls public https URLs. `OCSO_PUBLIC_URL` must be the https
  origin Slack can reach; the webhook URL OCSO shows is built from it.
- **OCSO rights.** Adding the channel needs `channels.manage` (a Tech admin). Activating it needs a
  second person who can approve channels.
- **Somewhere safe for two secrets.** The bot token and the signing secret go only into OCSO's form,
  never into chat or tickets.

## Set it up

OCSO walks you through these steps in the channel dialog (**Integrations → Channels → Add channel →
Slack**). The dialog first saves a **draft** with just the name, so the webhook URL exists before the
Slack app does. A draft is inert: it takes in no messages until its activation is approved, and it may
stay incomplete until then. Close the dialog at any time and come back with **Edit**.

1. **Create the Slack app from the manifest.** The dialog offers the manifest as YAML and JSON (copy
   or download), with this channel's webhook URL already filled in for Event Subscriptions and
   Interactivity. At [api.slack.com/apps](https://api.slack.com/apps) choose **Create New App → From
   an app manifest**, pick the workspace and paste it. Rename the app and bot if you like. Slack may
   say the Request URL is not verified yet: that is expected until step 6.
2. **Review the bot token scopes** under OAuth & Permissions (table below).
3. **Install to Workspace.** If installs are restricted, a workspace admin approves the request.
4. **Copy the Bot User OAuth Token** (`xoxb-…`, OAuth & Permissions) and the **Signing Secret**
   (Basic Information → App Credentials).
5. **Paste them into OCSO and save.** The form sits in this step of the guide. Secrets are write-only:
   OCSO never shows them again. Changing them later on a live channel is a governed change.
6. **Event Subscriptions: the Request URL shows Verified.** Once the signing secret is saved, OCSO
   answers Slack's signed challenge, even while the channel is a draft. If it shows as unverified,
   choose **Retry**.
7. **Interactivity** is on, with the same Request URL (button taps arrive there).
8. **App Home**: Messages Tab on, and "Allow users to send Slash commands and messages from the
   messages tab" checked. Without it people cannot DM the app.
9. **Invite the bot** to each channel where it should answer @mentions: `/invite @ocso-assistant`
   (or your bot's name). DMs need no invite.
10. **Test.** **Test connection** calls `auth.test`: it reports the workspace and bot user, names each
    missing scope and what breaks without it, and checks that the Request URL is https. It never posts
    a message. Then activate the channel (a second person approves) and DM the app.

### The manifest

`display_information` (name `OCSO Assistant`), a bot user `ocso-assistant` (Slack allows only
`a-z`, `0-9`, `-`, `_` and `.` in the bot's display name), `app_home` with the Messages tab on and
`messages_tab_read_only_enabled: false`, the bot scopes below, the bot events `message.im` and
`app_mention` and interactivity, both on the channel's webhook URL, and `socket_mode_enabled`,
`token_rotation_enabled` and `org_deploy_enabled` all false. The download is also available from
`GET /v1/channels/:id/setup-files/slack-app-manifest-yaml` (or `slack-app-manifest` for JSON).

| Scope | Why OCSO needs it |
|---|---|
| `chat:write` | Post replies (`chat.postMessage`) in DMs and in threads under @mentions. Required. |
| `im:history` | Receive DMs to the app (`message.im`). Required. |
| `app_mentions:read` | Receive @mentions in channels (`app_mention`). Required. |
| `users:read` | Optional. Read the writer's profile. OCSO does not call it yet; requested so profile lookups work without a reinstall. |
| `users:read.email` | Optional. Read the writer's email, to match Slack users to OCSO users. Not called yet either. |

**Test connection** fails when a required scope is missing and only notes a missing optional one.

## Troubleshooting

| Problem | Fix |
|---|---|
| Request URL not verified | Save the channel with the signing secret first, then **Retry** in Slack. The URL must be exactly the webhook URL shown, on an https `OCSO_PUBLIC_URL`. |
| `not_in_channel` on a reply to an @mention | `/invite @your-bot` in that channel. |
| `missing_scope`, or Test connection lists a missing scope | Add the scope (or re-paste the manifest), then **reinstall** the app: scope changes apply only after reinstalling. Paste the new bot token if it changed. |
| DMs never arrive | Turn on the Messages Tab and "Allow users to send … messages", check `im:history` and `message.im` (reinstall after changes), and that **Respond to** includes DMs. |
| Everything refused after the signing secret was regenerated | Paste the new secret and save. On a live channel the change needs approval, so rotate when a checker is available. |
| Slack rejected the bot token | The app was uninstalled or the token revoked: reinstall and paste the new `xoxb-…` token. |
| Enterprise Grid: a workspace cannot use the app | An org admin adds the app to each workspace. The manifest keeps org-wide deployment off. |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `respondTo` | `dm_and_mentions` | `dm`, `mentions` or `dm_and_mentions`. |
| `replyInThread` | `true` | Answer an @mention in a thread under it (on) or in the channel (off). A message that is already in a thread is always answered there. |
| `allowedChannelIds` | `[]` | Channel ids (`C…`/`G…`) where @mentions are answered. Empty means every channel the app is in. DMs are not affected. |
| `apiBaseUrl` | `https://slack.com/api` | Override only for tests or an egress proxy. |

## How it behaves

- **Verification.** Every request must carry a valid `X-Slack-Signature`. That is HMAC-SHA256 of
  `v0:{timestamp}:{raw body}` with the signing secret, compared in constant time. The timestamp must be
  within 5 minutes. A signed `url_verification` is answered with its challenge and nothing is stored.
  Accepted events get an empty `200`.
- **Inbound.** OCSO handles DMs to the app (`message` with `channel_type: im`) and `app_mention`, as far
  as `respondTo` and `allowedChannelIds` allow. It ignores bot messages (including its own), edits,
  deletions, joins and other subtypes. The app's own mention is removed from the text. Other user,
  channel and link markup becomes readable text. `event_id` is the idempotency key, so Slack's retries
  are dropped as duplicates. The customer identity is `slack_user` with the value
  `<team_id>:<user_id>`. Lists show the Slack user id.
- **Where replies go.** Each inbound message records a reply context: `{ teamId, channel, threadTs? }`.
  A reply goes where the message it answers came from: an agent reply uses the latest context up to its
  turn's input, so a DM answer stays in the DM even if the customer @mentions the app in a channel while
  the turn runs. With no recorded context, OCSO posts to the customer's DM (`chat.postMessage` to the
  user id).
- **Outbound.** Markdown becomes Slack mrkdwn: bold, italics, strikethrough, `<url|label>` links,
  headings as bold lines, bullets, and tables as rows. `&`, `<` and `>` are escaped. Only http(s) and
  mailto links become `<…>` links; any other link target is written as plain text, so agent output
  cannot produce `@channel`, `@here`, `@everyone`, user or user-group mentions. Link and media
  unfurls are off. Text is split at 40,000 characters.
- **Choice questions.** A router's choice question becomes a Block Kit section with up to 25 buttons.
  Each button's `action_id` is `ocso.choice:<option id>`. A click (interactivity `block_actions`)
  comes back as a `STRUCTURED` `button_reply` part with `data.id` set to the option id, the same shape
  as WhatsApp and web chat. The actions block's `block_id` is `ocso.choices:<user id>` of the customer
  asked; a click by anyone else is ignored, and clicks pass the same `respondTo` and
  `allowedChannelIds` checks as messages. If the labels would be ambiguous, OCSO sends the numbered text instead.
- **Rate limits and errors.** When Slack answers HTTP 429, OCSO waits for `Retry-After` and retries
  in place. It does this up to 2 times, and only if the wait is at most 10 seconds. Longer waits go
  back to the outbox backoff. Auth, scope and "channel not found" errors fail without retrying.
  5xx errors and network failures are retried.

## Not in v1

- **Files.** Files people share are not imported: only the text of the message is read. OCSO does not
  send files either, because that would need `files:write` and Slack's two-step upload.
- **Delivery receipts.** Slack has none. Messages stay `SENT`.
- **Display names.** Names are not looked up with `users.info` (the optional `users:read` scope is requested for this later). The inbox shows the profile name when
  the event carries one, and otherwise the user id.
