# Chat SDK reference

Two packages let you build your own customer chat UI on an OCSO web chat channel, in the browser or in React
Native:

- `@winsendotai/ocso-chat`: a headless client with no runtime dependencies.
- `@winsendotai/ocso-chat-react`: React hooks, web components and React Native components built on it.

This page is for front-end and mobile developers. If you only need the ready-made widget on a website, the embed
snippet in the channel's setup guide is enough; see [web chat](../guides/channels/web-chat.md).

Sources: [`packages/ocso-chat`](../../packages/ocso-chat) and [`packages/ocso-chat-react`](../../packages/ocso-chat-react)
(each has a README). A host-page example lives in [`examples/webchat-host`](../../examples/webchat-host).

> [!NOTE]
> Both packages are at version 0.1.0 and **not published to npm yet**. Build them from the repository
> (`pnpm --filter @winsendotai/ocso-chat build`, then `pack`, and the same for `@winsendotai/ocso-chat-react`) and
> install the tarballs. Semantic versioning; 0.x minor versions may change the API.

## Package facts

| | `@winsendotai/ocso-chat` | `@winsendotai/ocso-chat-react` |
|---|---|---|
| Entry points | `.` | `.` (web, hooks), `./native` (React Native), `./styles.css` |
| Peer dependencies | none | `@winsendotai/ocso-chat ^0.1.0`, `react >=18`, `react-native >=0.74` (optional; `./native` only) |
| Module format | ESM only | ESM only; every module starts with `'use client'` |
| Runs on | modern browsers, React Native 0.74+, Node 20+ | React 18+ web, React Native 0.74+ |

## What it talks to

The client speaks OCSO's public web chat API under `<baseUrl>/public/webchat/<publishableKey>`:

| Route | Used for |
|---|---|
| `GET /config` | Branding, limits, allowed attachment types. |
| `POST /session` | Open or resume a visitor session (visitor token, session pass or user token, plus `context`). |
| `POST /session-pass` | **Your server only**: mint a session pass with the channel secret key. OCSO refuses a request carrying an `Origin` header. |
| `GET /messages?afterSeq=` | History and gap fill; also the polling transport. |
| `POST /messages` | Send a message (idempotent client id). |
| `POST /attachments` | Upload a file (raw body). |
| `POST /csat` | Rate the conversation. |
| `GET /stream` | Live events over server-sent events. |

Calls use bearer tokens, never cookies. The channel's allowed origins must include your site. Rate limits per
channel and address or visitor apply (see `OCSO_WEBCHAT_RATE_LIMITS` in [configuration](configuration.md)).

## `createOcsoChat(options)`

```ts
import { createOcsoChat } from '@winsendotai/ocso-chat';

const chat = createOcsoChat({
  baseUrl: 'https://support.example.com', // your OCSO public origin
  publishableKey: 'pk_...',               // the channel's publishable key (safe to ship)
});

chat.subscribe((state) => render(state.messages, state.status, state.typing));
chat.on('message', (m) => notify(m));

await chat.connect();
await chat.send('Where is my card?');
```

### Options (`OcsoChatOptions`)

| Option | Default | Description |
|---|---|---|
| `baseUrl` | required | OCSO origin. The public web chat routes live under `/public/webchat`. |
| `publishableKey` | required | The channel's publishable key. |
| `mode` | none | `'anonymous' \| 'client' \| 'user'`. Informational: OCSO enforces the channel's mode. |
| `getSessionPass` | none | `() => Promise<string>`: fetch a session pass from **your** server. Called before every session exchange, and once more if OCSO says the pass is missing, expired or used. |
| `getUserToken` | none | `() => Promise<string \| null>`: the signed-in user's token (JWT), verified by OCSO. |
| `context` | none | `Record<string, string \| number \| boolean>` sent with the session. Unverified unless it comes inside a session pass; OCSO keeps only the keys the channel allows. |
| `storage` | `localStorage`, else memory | `{ get, set, remove }`, sync or async (for example AsyncStorage). Holds the visitor token. `memoryStorage()` is exported. |
| `transport` | `'auto'` | `'auto'`, `'sse'` or `'poll'`. See [Transports](#transports). |
| `pollIntervalMs` | `2000` | Poll interval for the polling transport. |
| `fetch` | global `fetch` | A `fetch` implementation. |

### Client methods (`OcsoChatClient`)

| Method | Description |
|---|---|
| `connect()` | Open or resume the visitor session and start the live stream. Idempotent. |
| `disconnect()` | Stop the live stream; the session is kept. |
| `reconnect()` | Restart after an error you have fixed. |
| `send(text \| { text?, attachments?, choice? })` | Shows the message at once (`status: 'sending'`), uploads attachments, posts it with an idempotent `cm_…` id, retries with backoff (honours `Retry-After`), then `sent` or `failed`. |
| `sendChoice({ id, label })` | Answer a `choices` part with a structured reply. |
| `retry(id)` / `discard(id)` | For a `failed` message. |
| `upload(file, signal?)` | Upload a `File`/`Blob` or a React Native `{ uri, name, type }` ahead of sending. Resolves to `{ uploadId, mimeType, sizeBytes, filename, sha256? }`, which `send({ attachments: [receipt] })` posts without uploading again. |
| `identify(userToken)` | Sign the visitor in; the conversation view reloads. |
| `reset()` | Forget the visitor (sign-out) and start a fresh session. |
| `rateCsat(1..5, comment?)` | Rate the latest conversation. |
| `getState()` / `subscribe(listener)` | Immutable `ChatState`. |
| `on(event, fn)` | Events: `message`, `notice`, `status`, `mode`, `error`, `identified`, `state`. Returns an unsubscribe function. |

Helpers: `checkAttachment(file, config)`, `acceptedMimeTypes(config)`, `attachmentsEnabled(config)`,
`linkify(text)`, `noticeText(kind, name)`, `mimeTypeOf`, `ChatApiError` (`status`, `code`, `retryAfterMs`),
`createSseParser`, `backoffDelay`, `OCSO_CHAT_VERSION`.

### State

```ts
{
  status: 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'offline' | 'error';
  mode: 'ai' | 'waiting' | 'human' | 'resolved';   // who handles the conversation
  messages: ChatMessage[];
  typing: { who: 'ai' | 'human'; name?: string } | null;
  notices: ChatNotice[];                           // hand-off events: waiting, joined, ai_resumed, resolved
  error: { code: string; message: string } | null;
  config: WebChatConfig | null;                    // branding, limits, allowed types
  conversationId, agentName, humanName, authenticated, transport
}
```

`ChatMessage.role` is `customer`, `assistant` (the AI), `agent` (a human colleague) or `system`. Ids stay stable from
the optimistic copy to the stored one, so they are safe as React keys. Parts are `text`, `media` (`image`, `audio`,
`video`, `document`), `choices` (answer with `sendChoice`) and `unavailable` (media the customer cannot open).

Transient failures (network, 5xx, 429) retry with backoff (`reconnecting`). Failures that retrying cannot fix set
`status: 'error'` with the server's code, for example `webchat_origin_not_allowed`, `session_pass_required` or
`user_token_required`. Call `reconnect()` after fixing the cause.

## Transports

| `transport` | Behaviour |
|---|---|
| `'auto'` (default) | SSE (`GET /stream`) when the platform's `fetch` can stream a response body. On platforms that cannot (React Native's built-in `fetch`) it polls from the start. If an SSE response arrives without a readable body, it switches to polling for good. |
| `'sse'` | Always SSE. Use it on React Native with a streaming `fetch` (for example `expo/fetch`), passed as `fetch`. |
| `'poll'` | Always poll `GET /messages?afterSeq=` every `pollIntervalMs`. |

Reconnects fill gaps from history by sequence number, so no message is lost between stream drops.

## Authentication modes

Configured per channel by an OCSO admin:

| Mode | Who can chat | What your app does |
|---|---|---|
| `anonymous` | Anyone with the publishable key on an allowed website. | Nothing. Requests without an `Origin` header (native apps) are refused unless the admin enables *allow native apps*. |
| `client` | Only sessions with a *session pass* your server minted with the channel **secret key**. | Pass `getSessionPass`. The secret key never ships to the browser or app. |
| `user` | Only sessions with a verified user: a session pass minted with a `userToken`, or a `userToken` (JWT) OCSO verifies itself (JWKS or HS256, as the channel is configured). | Pass `getSessionPass` or `getUserToken`. |

Mint a pass on your server:

```ts
// POST /api/chat-pass on your backend; authenticate your own user first.
const res = await fetch(`${OCSO_URL}/public/webchat/${PUBLISHABLE_KEY}/session-pass`, {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.OCSO_WEBCHAT_SECRET_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({ userToken: req.user.jwt, context: { plan: req.user.plan }, ttlSeconds: 600 }),
});
const { sessionPass, expiresAt } = await res.json();
```

`ttlSeconds` is 60–3600. Passes are single use. Context inside a pass is trusted ("verified" to the agent); context
in `options.context` is not. Wrong secret keys are rate limited per channel and address.

## React: `@winsendotai/ocso-chat-react`

### Drop-in panel (web)

```tsx
import { OcsoChat } from '@winsendotai/ocso-chat-react';
import '@winsendotai/ocso-chat-react/styles.css';

export function Support() {
  return (
    <div style={{ height: 560 }}>
      <OcsoChat options={{ baseUrl: 'https://support.example.com', publishableKey: 'pk_...' }} />
    </div>
  );
}
```

`<OcsoChat>` takes `options` or `client`, plus `title`, `subtitle`, `placeholder`, `csat`, `classNames`, `labels`,
`renderMessage`, `renderPart`, `className` and `style`. It shows the channel's branding, the message log, a typing
indicator, tappable choices, attachments within the channel's limits, a reconnect banner and a 1–5 rating once
the conversation is resolved.

### Hooks and provider

| Export | Description |
|---|---|
| `OcsoChatProvider` | Provides one client. Pass `options` (the provider creates it, connects, and disconnects on unmount) or your own `client`. `autoConnect={false}` to connect later. |
| `useOcsoChat()` | `client, state, messages, status, mode, typing, error, config, input, setInput, attachments, setAttachments, handleSubmit, isSending, send, sendChoice, upload, retry, discard, identify, reset, rateCsat, connect, reconnect`. |
| `useOcsoChatState(selector, isEqual?)` | Subscribe to one slice; re-renders only when it changes. |
| `useOcsoChatClient()` | The client from the provider. |
| `latestChoices` | Helper: the latest open choices in a message list. |

### Composable web parts

`<MessageList />`, `<Composer />`, `<ChoiceButtons />`, `<TypingIndicator />` and `<RichText />` work inside an
`OcsoChatProvider`. Customise with CSS variables on `.ocso-chat` (`--ocso-accent`, `--ocso-bg`, `--ocso-text`,
`--ocso-radius`, `--ocso-font` and more; the full list is in the package README), per-slot `classNames`, render props
and `labels` (every visible string; `defaultLabels` is exported). The log is a polite `role="log"` live region,
Enter sends and Shift+Enter adds a line, and text is never rendered as HTML.

### React Native: `/native`

```tsx
import { OcsoChatView } from '@winsendotai/ocso-chat-react/native';

<OcsoChatView
  options={{ baseUrl, publishableKey, mode: 'client', getSessionPass, storage: asyncStorageAdapter }}
  theme={{ accent: '#0f766e', radius: 12 }}
  onPickAttachment={pickFiles} // returns { uri, name, type } assets, or null
/>
```

The `./native` entry exports `OcsoChatView`, `NativeChoiceButtons`, `NativeRichText`, `lightTheme`, `darkTheme`,
`defaultLabels`, and the same provider and hooks. It imports nothing from `react-dom` or the DOM. React Native's
built-in `fetch` cannot stream, so the client polls (every 2 seconds by default). Both packages ship `main` fields
and a `native/package.json` stub, so Metro resolves them with or without package-exports support.

## ESM notes

Both packages are ESM only. Bundlers (Vite, webpack, Next.js, Metro) work as they are. `require()` works without a
flag on Node 22.12+ and 20.19+. Jest needs ESM mode or
`transformIgnorePatterns: ['node_modules/(?!@winsendotai/)']`. Vitest needs nothing.

## Limits and known gaps

- Not on npm yet (see the note at the top).
- `mode` in the options is informational only; a mismatch with the channel's real mode surfaces as a
  `session_pass_required` or `user_token_required` error.

## Related

- [Web chat channel](../guides/channels/web-chat.md)
- [HTTP API reference](http-api.md)
- [Configuration](configuration.md)
- [Plugin SDK](plugin-sdk.md)
