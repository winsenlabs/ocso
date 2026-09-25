# @winsendotai/ocso-chat

Headless client for [OCSO](https://github.com/winsenlabs/ocso) web chat. Build your own chat UI on top of an
OCSO web chat channel, in the browser or in React Native, with no runtime dependencies.

It speaks OCSO's public web chat API (`/public/webchat/:publishableKey/*`) and handles what a chat UI should
not have to: visitor sessions with sliding renewal, session passes from your server, live streaming over SSE (or
polling where streaming is not possible), reconnects with gap fill, idempotent retries, AI replies streaming in,
hand-off to a human colleague, attachments and tappable choices.

For React and React Native components see
[`@winsendotai/ocso-chat-react`](https://www.npmjs.com/package/@winsendotai/ocso-chat-react).

```sh
npm install @winsendotai/ocso-chat
```

> **Not on npm yet.** OCSO is pre-1.0 and this package has not been published. Until it is, build it
> from the [OCSO repository](https://github.com/winsenlabs/ocso) with `pnpm --filter @winsendotai/ocso-chat build`
> and install the tarball from `pnpm --filter @winsendotai/ocso-chat pack`.

## Quick start

```ts
import { createOcsoChat } from '@winsendotai/ocso-chat';

const chat = createOcsoChat({
  baseUrl: 'https://support.example.com', // your OCSO API origin
  publishableKey: 'pk_...',               // the channel's publishable key (safe to ship)
});

chat.subscribe((state) => render(state.messages, state.status, state.typing));
chat.on('message', (m) => notify(m));      // a reply from the assistant or a colleague

await chat.connect();
await chat.send('Where is my card?');
```

`connect()` opens (or resumes) the visitor session and starts the live stream. The visitor token is kept in
`localStorage` when available (memory otherwise); pass `storage` to use something else, e.g. AsyncStorage:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';

createOcsoChat({
  baseUrl, publishableKey,
  storage: { get: (k) => AsyncStorage.getItem(k), set: (k, v) => AsyncStorage.setItem(k, v), remove: (k) => AsyncStorage.removeItem(k) },
});
```

## Options

| option | |
|---|---|
| `baseUrl` | OCSO API origin (required). |
| `publishableKey` | The channel's publishable key (required). |
| `mode` | `'anonymous' \| 'client' \| 'user'`: how the channel authenticates sessions. Informational: OCSO enforces it. |
| `getSessionPass` | `() => Promise<string>`: fetch a session pass from **your** server (see below). Called before every session exchange and once more if OCSO says the pass is missing, expired or used. |
| `getUserToken` | `() => Promise<string \| null>`: the signed-in user's token (JWT), verified by OCSO. |
| `context` | `Record<string, string \| number \| boolean>` sent with the session (e.g. `{ plan: 'gold' }`). Unverified unless it comes inside a session pass; OCSO keeps only the keys the channel allows. |
| `storage` | `{ get, set, remove }`, sync or async. |
| `transport` | `'auto'` (default: SSE when the platform can stream a response body, else polling; React Native always polls), `'sse'`, `'poll'`. |
| `pollIntervalMs` | Poll interval (default 2000). |
| `fetch` | A `fetch` implementation (default: the global one). |

## Authentication modes

Configured per channel by the OCSO admin:

- **anonymous**: anyone with the publishable key on an allowed website can chat (today's widget behaviour).
- **client**: every session needs a *session pass* minted by your server with the channel's **secret key**. The
  secret key never ships to the browser or the app.
- **user**: the session must carry a verified user: a session pass minted with a `userToken`, or a `userToken`
  (JWT) that OCSO verifies itself (JWKS or HS256, as configured).

Mint a pass on your server (Node example):

```ts
// POST /api/chat-pass  (your backend; authenticate your own user first)
const res = await fetch(`${OCSO_URL}/public/webchat/${PUBLISHABLE_KEY}/session-pass`, {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.OCSO_WEBCHAT_SECRET_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({ userToken: req.user.jwt, context: { plan: req.user.plan }, ttlSeconds: 600 }),
});
const { sessionPass } = await res.json();
```

and hand it to the client:

```ts
createOcsoChat({
  baseUrl, publishableKey, mode: 'client',
  getSessionPass: async () => (await fetch('/api/chat-pass', { method: 'POST' }).then((r) => r.json())).sessionPass,
});
```

Context inside a pass is trusted ("verified" to the agent); context passed in `options.context` is not.

## State

`getState()` / `subscribe(listener)` give an immutable `ChatState`:

```ts
{
  status: 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'offline' | 'error';
  mode: 'ai' | 'waiting' | 'human' | 'resolved';   // who is handling the conversation
  messages: ChatMessage[];
  typing: { who: 'ai' | 'human'; name?: string } | null;
  notices: ChatNotice[];                           // hand-off events (also in messages as role 'system')
  error: { code: string; message: string } | null;
  config: WebChatConfig | null;                    // branding, limits, allowed types
  conversationId, agentName, humanName, authenticated, transport
}
```

`ChatMessage = { id, role: 'customer' | 'assistant' | 'agent' | 'system', parts, createdAt, status?, author?, streaming?, notice?, error?, seq? }`.

`status` is `connecting` until the live stream is open. Transient failures (network, 5xx, 429) retry with backoff
(`reconnecting`). Failures retrying cannot fix stop the stream, set `status: 'error'` and `error` to the server's code,
and emit `error`. Examples are `webchat_origin_not_allowed`, a session pass or user token the host cannot supply
(`session_pass_required`, `user_token_required`…), or a token the stream keeps refusing. Call `reconnect()` after
fixing the cause.
`assistant` is the AI, `agent` a human colleague. Ids are stable from the optimistic copy to the stored one, so
they are safe as React keys. Parts:

```ts
| { type: 'text'; text }                                   // render as text; `linkify()` finds http(s) links
| { type: 'media'; kind: 'image' | 'audio' | 'video' | 'document'; url; name?; mime? }
| { type: 'choices'; prompt?; options: { id; label }[] }   // show buttons; answer with sendChoice()
| { type: 'unavailable'; reason }                          // media the customer cannot open (expired, blocked…)
```

## Methods

| | |
|---|---|
| `connect()` / `disconnect()` / `reconnect()` | Lifecycle. `connect` is idempotent. |
| `send(text \| { text?, attachments?, choice? })` | Shows the message at once (`status: 'sending'`), uploads attachments, posts it (idempotent `cm_…` id, retries with backoff, honours `Retry-After`), then `sent` or `failed`. |
| `sendChoice({ id, label })` | Answer a `choices` part: sent as a structured reply carrying the option id. |
| `retry(id)` / `discard(id)` | For a `failed` message. |
| `upload(file, signal?)` | Upload one `File`/`Blob`, or React Native `{ uri, name, type }`, ahead of sending. Resolves to a receipt `{ uploadId, mimeType, sizeBytes, filename, sha256? }` that `send({ attachments: [receipt] })` posts without uploading again. Aborting `signal` stops the upload and its retries. |
| `identify(userToken)` | Sign the visitor in (verified by OCSO); the conversation view is reloaded. |
| `reset()` | Forget the visitor (sign-out) and start a fresh session. |
| `rateCsat(1..5, comment?)` | Rate the latest conversation. |
| `on(event, fn)` | `message`, `notice`, `status`, `mode`, `error`, `identified`, `state`. Returns an unsubscribe. |

Helpers: `checkAttachment(file, config)`, `acceptedMimeTypes(config)`, `attachmentsEnabled(config)`, `linkify(text)`,
`noticeText(kind, name)`, `ChatApiError` (`status`, `code`, `retryAfterMs`).

## Platforms

- Browsers: any modern browser. Calls go straight to OCSO with bearer tokens (no cookies); the channel's
  allowed origins must include your site.
- React Native ≥ 0.74: works with the built-in `fetch`. RN's `fetch` resolves only once a response is complete, so
  it cannot stream: on React Native `transport: 'auto'` polls history (every 2 s by default) and never opens the
  stream. With a streaming fetch (for example `fetch` from `expo/fetch`), pass it as `fetch` and set `transport: 'sse'`. Channels in `anonymous` mode refuse requests without an `Origin`
  header unless the admin enables *allow native apps*; with a session pass or user token no extra setting is needed.
- Node ≥ 20 (e.g. tests, bots).

## ESM only

`@winsendotai/ocso-chat` ships ES modules only (no CommonJS build). Bundlers (Vite, webpack, Next.js, Metro) and
`import` in Node ≥ 20 work as they are. The `exports` map also has a `default` condition, so resolvers that do
not ask for `import` still find the files, but the files are still ESM:

- **`require()` from CommonJS**: works without a flag on Node 22.12+ (and 20.19+), which load ES modules
  through `require()`. On older Node 20 releases use `await import('@winsendotai/ocso-chat')`.
- **Jest**: either run Jest in ESM mode (`node --experimental-vm-modules node_modules/.bin/jest`), or let
  its transformer compile the package: `transformIgnorePatterns: ['node_modules/(?!@winsendotai/)']`.
- **React Native Jest** (the `react-native` preset): add the package scope to the preset's list, for example
  `transformIgnorePatterns: ['node_modules/(?!((jest-)?react-native|@react-native(-community)?|@winsendotai)/)']`.
- **Vitest** needs nothing.

## Versioning

Semantic versioning. `0.x` minor versions may change the API; patch versions do not.

## License

Apache-2.0
