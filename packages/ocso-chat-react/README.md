# @winsendotai/ocso-chat-react

React hooks and components for [OCSO](https://github.com/winsenlabs/ocso) web chat, for the web and React
Native. Built on the headless [`@winsendotai/ocso-chat`](https://www.npmjs.com/package/@winsendotai/ocso-chat)
client.

```sh
npm install @winsendotai/ocso-chat-react @winsendotai/ocso-chat
```

> **Not on npm yet.** OCSO is pre-1.0 and this package has not been published. Until it is, build it
> from the [OCSO repository](https://github.com/winsenlabs/ocso) with `pnpm --filter @winsendotai/ocso-chat-react build`
> and install the tarball from `pnpm --filter @winsendotai/ocso-chat-react pack`.

`@winsendotai/ocso-chat` is a **peer dependency** (one client version per app, which you control), as are
`react >= 18` and, for the `./native` entry only, `react-native >= 0.74`.

## Drop-in panel (web)

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

The components and hooks are client components: every module (and both entry points) starts with
`'use client'`, so a Next.js App Router Server Component can render `<OcsoChat />` directly. Options such as
`getSessionPass` are functions, so pass them from a client component of your own.

The panel shows the channel's branding (title, greeting, accent colour), the message log, a typing indicator,
tappable choices, attachments within the channel's limits, a reconnect banner, and a 1–5 rating once the
conversation is resolved.

## Hooks (build your own UI)

```tsx
import { OcsoChatProvider, useOcsoChat } from '@winsendotai/ocso-chat-react';

function App() {
  return (
    <OcsoChatProvider options={{ baseUrl, publishableKey, mode: 'client', getSessionPass }}>
      <Chat />
    </OcsoChatProvider>
  );
}

function Chat() {
  const { messages, status, typing, input, setInput, handleSubmit, sendChoice } = useOcsoChat();
  return (
    <form onSubmit={handleSubmit}>
      {messages.map((m) => <Message key={m.id} message={m} onChoose={sendChoice} />)}
      {typing ? <p>{typing.name ?? 'Assistant'} is typing…</p> : null}
      <input value={input} onChange={(e) => setInput(e.target.value)} aria-label="Message" />
    </form>
  );
}
```

- `OcsoChatProvider`: `options` (creates the client, connects, disconnects on unmount) or `client` (yours).
  `autoConnect={false}` to connect later (`useOcsoChat().connect()`, e.g. when a launcher opens).
- `useOcsoChat()`: `messages, status, mode, typing, error, config, input, setInput, attachments, setAttachments,
  handleSubmit, isSending, send, sendChoice, upload, retry, discard, identify, reset, rateCsat, connect, reconnect, client`.
- `useOcsoChatState(selector, isEqual?)`: subscribe to one slice; re-renders only when it changes.

See the `@winsendotai/ocso-chat` README for options, auth modes (session pass from your server, user tokens),
message and part shapes.

## Composable parts (web)

`<MessageList />`, `<Composer />`, `<ChoiceButtons />`, `<TypingIndicator />` work inside an `OcsoChatProvider`.

Customise with:

- **CSS variables** on `.ocso-chat` or any ancestor: `--ocso-accent`, `--ocso-on-accent`, `--ocso-bg`,
  `--ocso-surface`, `--ocso-text`, `--ocso-muted`, `--ocso-border`, `--ocso-radius`, `--ocso-font`,
  `--ocso-font-size`, `--ocso-bubble-customer`, `--ocso-bubble-customer-text`, `--ocso-bubble-assistant`,
  `--ocso-bubble-assistant-text`, `--ocso-danger`, `--ocso-gap`. Or skip `styles.css` and style the
  `ocso-chat__*` classes yourself.
- **`classNames`**: extra classes per slot (`root, header, log, message, bubble, part, choices, choice, composer,
  input, send, …`), e.g. for Tailwind.
- **Render props**: `renderMessage(message, defaultRender)` and `renderPart(part, message, defaultRender)`.
- **`labels`**: every visible string (for translation).

Accessibility: the log is a `role="log"` polite live region, the composer is labelled, Enter sends and
Shift+Enter adds a line, choices are a labelled button group, typing is announced through `role="status"`,
failed messages are `role="alert"` with Retry/Delete buttons. Links open only for `http(s)` URLs and text is
never rendered as HTML.

## React Native

```tsx
import { OcsoChatView } from '@winsendotai/ocso-chat-react/native';
import * as DocumentPicker from 'expo-document-picker';

<OcsoChatView
  options={{ baseUrl, publishableKey, mode: 'client', getSessionPass, storage: asyncStorageAdapter }}
  theme={{ accent: '#0f766e', radius: 12, fontFamily: 'Inter' }}
  onPickAttachment={async () => {
    const r = await DocumentPicker.getDocumentAsync({ type: ['image/*', 'application/pdf'] });
    return r.canceled ? null : r.assets.map((a) => ({ uri: a.uri, name: a.name, type: a.mimeType ?? '' }));
  }}
/>
```

`OcsoChatView` renders a header, a `FlatList` of messages, a typing line, choice buttons and a `TextInput`
composer; attachments are `{ uri, name, type }` objects from any picker. The entry re-exports the provider and
hooks and imports nothing from `react-dom` or the DOM. React Native's `fetch` cannot stream, so the client
polls for new messages (every 2 s by default).

Both packages ship `main` fields and a `native/package.json` stub, so Metro resolves them with or without
package-exports support (it is on by default from React Native 0.79).

## ESM only

`@winsendotai/ocso-chat-react` ships ES modules only (no CommonJS build). Bundlers (Vite, webpack, Next.js, Metro) and
`import` in Node ≥ 20 work as they are. The `exports` map also has a `default` condition, so resolvers that do
not ask for `import` still find the files, but the files are still ESM:

- **`require()` from CommonJS**: works without a flag on Node 22.12+ (and 20.19+), which load ES modules
  through `require()`. On older Node 20 releases use `await import('@winsendotai/ocso-chat-react')`.
- **Jest**: either run Jest in ESM mode (`node --experimental-vm-modules node_modules/.bin/jest`), or let
  its transformer compile the package: `transformIgnorePatterns: ['node_modules/(?!@winsendotai/)']`.
- **React Native Jest** (the `react-native` preset): add the package scope to the preset's list, for example
  `transformIgnorePatterns: ['node_modules/(?!((jest-)?react-native|@react-native(-community)?|@winsendotai)/)']`.
- **Vitest** needs nothing.

## License

Apache-2.0
