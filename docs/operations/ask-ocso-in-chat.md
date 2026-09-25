# Ask OCSO in Slack and Microsoft Teams

Staff can talk to Ask OCSO from a workplace chat as themselves: same permissions, same confirmation cards, same
approvals and audit as the drawer.

## Set it up

1. Add a Slack or Microsoft Teams channel under Integrations → Channels (see the channel's own setup page).
2. Set its **Destination** to `ask_ocso`. The setting exists on every channel kind whose descriptor sets
   `staffDestination` (Slack and Teams today); `router` (the default) keeps the channel for customers. Like every
   channel setting, the change goes through the channel approval.
3. A Tech admin chooses Ask OCSO's model in Settings (as for the drawer).

An `ask_ocso` channel never creates customer conversations and needs no router.

## Linking a chat account

- The first message from an unknown chat account gets a reply, sent to that person directly where the chat allows
  (a Slack DM): `Link your account: <OCSO_PUBLIC_URL>/link/<token>`.
- The link works once, for 10 minutes, and is bound to that channel and chat account. Only its sha256 is stored.
  At most three links go out per chat account per 10 minutes.
- Opening it asks the person to sign in to OCSO (and back). The page shows the chat account (with its full id:
  Slack workspace and user, Teams tenant and user), the channel and the OCSO account it would link.
- **Confirm** does not link yet: the page shows a 6-digit code, and the chat hears "Almost linked: send me the code".
  The link is made (audited as `channel.account_link`, actor = the OCSO user) only when that code is sent from the
  same chat account; the chat then hears "Linked. Ask me anything." Five wrong codes burn the link. This is the
  proof that the OCSO user holds the chat account: without it, anyone who can message the app could send their
  link to an admin ("please confirm my access") and then ask Ask OCSO as that admin. The page tells the user never
  to give the code to anyone.
- Linking a chat account that is already linked to the same user (e.g. after the MFA policy tightened) needs no
  code: it only refreshes how they signed in.
- It is refused when the link expired or was used, when the user is not active or lacks `internal_agent.use`, and
  when that chat account is already linked to another active user.

## Using it

- Every message re-checks the link, the user (active, `internal_agent.use`) and the MFA policy as they signed in
  when they linked. Otherwise the chat hears that access was removed, or gets a fresh link.
- Each chat thread continues its own Ask OCSO thread, marked with the surface (`slack`, `teams`: the descriptor's `staffSurface`, else the kind in lower case); it also shows
  in the drawer's history.
- Answers are final text (no streaming), with OCSO objects as absolute links. A link the model wrote to anywhere
  but OCSO is shown as its label and the visible target, never as a clickable link (the model reads customer text).
- Direct and stop cards come with **Confirm** and **Cancel** buttons. Only the same linked chat account can press
  them (anyone else is told the button is not theirs); the confirm path is the drawer's (hash check, expiry, single
  use) and a follow-up message gives the result.
- Governed cards (a checker and a reason) and cards that ask for credentials link into OCSO (`/?askOcso=<thread>`
  opens the drawer on that thread). Bootstrap self-approval is never offered.
- At most 20 messages a minute per linked account. The `ask_ocso_writes` kill switch still applies.

## How it runs as the user

There is no session in chat. Ask OCSO's delegated requests (loopback only, single use, bound to the request) carry
the link instead of a session. They are refused once the link is revoked, or the user is disabled or loses
`internal_agent.use`. Audit rows carry `via = INTERNAL_AGENT` and `confirmation.internalAgent.surface` / `linkId`.

## Revoking

- Account → Chat accounts: a user revokes their own links (immediate, audited as `channel.account_unlink`).
- Team → a user (Overview): a Tech admin with `users.manage` sees and revokes that user's links.
- Disabling a user revokes all their links, and so does break-glass recovery of a Tech admin.

Data: `channel_account_links`, `channel_link_tokens`, `channel_staff_messages` (dedupe and rate limit only, no
content) and three columns on `internal_agent_threads` (migration 0036).
