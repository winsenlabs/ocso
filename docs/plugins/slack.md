# Slack channel

The `SLACK` channel kind connects OCSO to a Slack app. People send the app a direct message or
@mention it in a channel. Slack posts those events, plus button clicks, to the channel's webhook. The
AI agent's replies go back with the bot token: in the DM, or in a thread under the mention. The code
is in `packages/channels/src/slack/`.

## Set it up

1. **Connections → Channels → Add channel → Slack.** Pick the settings (below). Leave the secrets for
   now if you don't have the app yet. Save: the channel is a draft until an approver activates it.
2. The channel's setup steps show a **Slack app manifest** with this channel's webhook URL already
   filled in. The same URL is used for Event Subscriptions and Interactivity. At
   [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App → From a manifest**, pick
   your workspace and paste it. Rename the app and bot user if you want.
3. **Install to Workspace.** Copy the **Bot User OAuth Token** (`xoxb-…`) from OAuth & Permissions and
   the **Signing Secret** from Basic Information into the channel's secrets. Secrets are write-only:
   OCSO never shows them again. Changing them later is a governed change, like any channel setting.
4. Once the channel is active, Slack checks the Request URL. If Event Subscriptions shows the URL as
   unverified, choose **Retry**. Slack only calls public **https** URLs, so `OCSO_PUBLIC_URL` must be
   the https origin Slack can reach.
5. `/invite @your-app` in each channel where it should answer @mentions. DMs work as soon as the app is
   installed.
6. **Test connection** calls `auth.test`. It reports the workspace and bot user, any missing bot scopes,
   and whether the Request URL is https. It never posts a message.

The manifest requests the bot scopes `chat:write`, `im:history`, `app_mentions:read`, `users:read` and
`users:read.email`, and the bot events `message.im` and `app_mention`.

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
- **Display names.** Names are not looked up with `users.info`. The inbox shows the profile name when
  the event carries one, and otherwise the user id.
