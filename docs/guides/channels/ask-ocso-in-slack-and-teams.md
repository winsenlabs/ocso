# Ask OCSO in Slack and Microsoft Teams

Staff can talk to Ask OCSO, OCSO's internal copilot, from Slack or Microsoft Teams, as themselves: the same
permissions, confirmation cards, approvals and audit as the Ask OCSO drawer in the web app. This page is for the
Tech admin who sets it up and for staff who use it. What Ask OCSO itself can do is in
[Ask OCSO](../../concepts/ask-ocso.md).

The code is in [apps/api/src/modules/internal-agent/staff-chat.service.ts](../../../apps/api/src/modules/internal-agent/staff-chat.service.ts)
and [packages/application/src/identity/channel-links.ts](../../../packages/application/src/identity/channel-links.ts).

> [!NOTE]
> Linking and chat answers are tested end to end through the API over a staff Slack channel with a fake Slack Web
> API (`apps/api/test/int/chat-links.int.test.ts`). Teams takes the same path through its adapter. The repository
> records no run against a live workspace or tenant.

## Prerequisites

- A Slack or Microsoft Teams channel, set up as in [Slack](slack.md) or [Microsoft Teams](microsoft-teams.md).
- Ask OCSO has a model: **Settings → Ask OCSO → Model profile** is set (a Tech admin; the change is submitted for
  approval). While it is **Not set — Ask OCSO is off**, the chat answers "Ask OCSO is not set up yet".
- Each person who will use it has an active OCSO account with `internal_agent.use` (all four presets hold it).

## Set it up

1. Open the channel under **Integrations → Channels** and choose **Edit**.
2. Set **Destination** to `ask_ocso`. The setting exists on every kind whose descriptor sets `staffDestination`
   (Slack and Teams today). `router`, the default, keeps the channel for customers. On a live channel the change is
   a proposal a Head approves, like any channel change.
3. Activate the channel if it is still a draft. An `ask_ocso` channel never creates customer conversations and needs
   no router.

A channel serves one audience: an `ask_ocso` channel cannot also serve customers. Use a second Slack app or Azure Bot
for customers.

## Link your chat account (staff)

You link once per chat account and channel.

1. Send the app any message. For Slack, a DM to the app; for Teams, a personal chat with the bot.
2. The app replies to you privately (a Slack DM, your Teams personal chat), never in a shared channel:
   `Link your account: https://<OCSO host>/link/<token>`. If you wrote in a shared channel or group chat and the
   app cannot reach you privately, it answers there only with "message me directly (a 1:1 chat with me) and I will
   send you a one-time link there".
3. Open the link. OCSO asks you to sign in (and returns to the link). The **Link your Slack account** (or Teams) page
   shows the chat account with its full id (Slack workspace and user, or Teams tenant and user), the channel and the
   OCSO account it would link.
4. Choose **Confirm**. This does not link yet: the page shows a 6-digit code, and the chat says "Almost linked: send
   me the 6-digit code the OCSO page shows you, here, to finish."
5. Send the code from the same chat account. The chat answers "Linked. Ask me anything."

Never give the code to anyone. The code is the proof that the OCSO user holds the chat account: without it, anyone
who can message the app could send their link to an admin ("please confirm my access") and then ask Ask OCSO as that
admin.

The rules, from `channel-links.ts`:

| Rule | Value |
|---|---|
| Link lifetime | 10 minutes, single use, bound to the channel and chat account |
| Links per chat account | at most 3 in 10 minutes (later messages get no new link) |
| Stored | only the link's sha256 |
| Wrong codes | 5 wrong codes burn the link |
| Refused when | the link expired or was used; the user is not active or lacks `internal_agent.use`; the chat account is already linked to another active user (they or a Tech admin must revoke it first) |
| Already linked to you | no code needed: **Confirm** only refreshes how you signed in (for example after the MFA policy tightened) |

The link is audited as `channel.account_link`, with the OCSO user as the actor.

## Use it

There are no slash commands: write to the app in plain text, in a DM or by @mentioning it where it was invited.

- **Every message re-checks** the link, the user (active, `internal_agent.use`) and the MFA policy as the user signed
  in when linking. If access was removed, the chat says so; if the MFA policy now requires more, the chat sends a
  fresh link.
- **Threads.** Each chat thread continues its own Ask OCSO thread, marked with the surface (`slack`, `teams`); it
  also shows in the drawer's history.
- **Answers** are final text, not streamed, with OCSO objects as absolute links. A link the model wrote to anywhere
  but OCSO is shown as its label and visible target, never as a clickable link.
- **Text only.** A message with no text gets "I read text only: ask me in words."
- **Direct and stop cards** (changes you may make yourself) come with **Confirm** and **Cancel** buttons. Only the
  same linked chat account can press them; anyone else is told the button is not theirs. Confirming follows the
  drawer's path (hash check, expiry, single use), and a follow-up message gives the result.
- **Governed cards** (a change that needs a checker and a reason) and cards that ask for credentials are not
  confirmed in chat: they link into OCSO with **Open in OCSO** (`/?askOcso=<thread>` opens the drawer on that
  thread). Bootstrap self-approval is never offered in chat.
- **Rate limit.** At most 20 messages a minute per linked account; beyond that the chat asks you to wait.
- **Writes off.** When **Let Ask OCSO propose changes** is off in **Settings → Ask OCSO** (the `askOcsoWrites`
  setting), Ask OCSO only answers questions, in chat as in the drawer.
- A request that takes longer than 3 minutes is stopped.

## How it runs as the user

There is no browser session in chat. Ask OCSO's delegated requests to the API carry the link instead: loopback only,
single use, bound to the request. They are refused once the link is revoked, or the user is disabled or loses
`internal_agent.use`. Audit rows carry `via = INTERNAL_AGENT` and the surface and link id in
`confirmation.internalAgent`.

## Revoke a link

- **Account → Chat accounts**: each user sees and revokes their own links. Revoking takes effect at once and is
  audited as `channel.account_unlink`.
- **Team → a user**: a Tech admin with `users.manage` sees and revokes that user's links under **Chat accounts**.
- Disabling a user revokes all their links, and so does break-glass recovery of a Tech admin.

After a revoke, the chat account gets a fresh link offer on its next message.

## Verify it works

1. DM the app: you receive a `/link/<token>` link privately.
2. Confirm on the page, send the code, and get "Linked. Ask me anything."
3. Ask "which channels are live?" and get an answer with links into OCSO.
4. Your link appears under **Account → Chat accounts**, and the thread appears in the drawer's history.

## Troubleshooting

| Problem | Fix |
|---|---|
| No link arrives | Write to the app directly (Slack DM, Teams personal chat). In Teams the bot cannot start a chat, so a first message in a channel cannot be answered privately. Three links in 10 minutes is the limit: wait. |
| "This link expired." / "This link was already used." | Send the app a new message for a fresh link. |
| "This chat account is already linked to another OCSO user." | That user, or a Tech admin under **Team**, revokes the old link first. |
| "Ask OCSO is not set up yet" | A Tech admin sets **Settings → Ask OCSO → Model profile**. |
| "Your OCSO access to Ask OCSO was removed" | The user is disabled or lost `internal_agent.use`. |
| A **Confirm** button says it is not yours | Only the person who asked can press it. |
| Messages go to a customer conversation instead | The channel's **Destination** is still `router`. |

## Limits and known gaps

- Text only; no files.
- No streaming in chat: answers arrive when complete.
- Governed changes cannot be confirmed in chat; they open OCSO.
- A channel serves either staff or customers. An explicit audience for agents and channels is on the
  [roadmap](../../../ROADMAP.md).

Data: `channel_account_links`, `channel_link_tokens`, `channel_staff_messages` (dedupe and rate limit only, no
content) and three columns on `internal_agent_threads` (migration 0036).

## Related

- [Ask OCSO](../../concepts/ask-ocso.md)
- [Slack](slack.md)
- [Microsoft Teams](microsoft-teams.md)
- [Channels overview](README.md)
- [Permissions reference](../../reference/permissions.md)
