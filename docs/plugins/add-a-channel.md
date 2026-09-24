# Worked example: add a channel in seven steps

This walks through adding a Telegram-shaped bot channel. **None of this code is in the repository.** It
is a sketch that shows where each piece goes and which contract types it fills. The Telegram Bot API
details (headers, endpoints, limits) are given for orientation; check them against Telegram's own
documentation before you build.

Read [channels.md](channels.md) first. It describes the contract and what the core does around it.

What you will touch:

| File | Change |
|---|---|
| `packages/channels/src/telegram/*` | the adapter (new) |
| `packages/channels/src/index.ts` | export it |
| `packages/bootstrap/src/first-party.ts` | one line: add `createTelegramAdapter` to the `@ocso/channels` entry |
| `packages/channels/test/*` | tests and fixtures (new) |
| `docs/operations/setup-guide.md`, `packages/channels/README.md` | operator setup and adapter notes |

What you do not touch: the API, the ingress service, the agent runtime, the prompt compiler, the
database (the `channels.kind` column is `text` and nothing enumerates kinds), the queue, or the web app.
The "Add channel" form, the channel card, the inbox badge, the setup steps, the Webhooks list and the
prompt's channel block all come from what the adapter declares.

## 1. Pick the kind

A kind is an upper-snake-case string: `'TELEGRAM'`. There is no list to add it to; the registry
accepts it when the adapter is registered, and refuses a malformed or duplicate one at start-up.

## 2. Settings and secrets

Non-secret settings are a zod schema. Its `.meta()` titles and descriptions become the form labels,
and `.default()` values become the "blank = default" hints.

```ts
// packages/channels/src/telegram/config.ts
export const TelegramSettings = z.object({
  apiBaseUrl: z.url().default('https://api.telegram.org')
    .meta({ title: 'API base URL', description: 'Override only for tests or an egress proxy.' }),
  requestTimeoutMs: z.number().int().min(1_000).max(120_000).default(15_000),
});

/** Problems as `settings.<path>: …` / `secrets.<key>: …` so the form shows them under the field. Never echo values. */
export function validateTelegramConfig(settings: unknown, secrets: Readonly<Record<string, string>>): string[] {
  const parsed = TelegramSettings.safeParse(settings ?? {});
  const problems = parsed.success ? [] : parsed.error.issues.map((i) => `settings.${i.path.join('.') || '(root)'}: ${i.message}`);
  if (!secrets['botToken']?.includes(':')) problems.push('secrets.botToken: must look like 123456:ABC…');
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(secrets['webhookSecret'] ?? '')) problems.push('secrets.webhookSecret: 16–256 characters, A–Z a–z 0–9 _ -');
  return problems;
}
```

## 3. Descriptor and capabilities

The descriptor is everything OCSO shows about the kind: the "Add channel" form, the channel card, the
badge in the inbox and analytics, the steps after saving, the webhook URL and the Webhooks list.
Setting `inboundWebhook: true` with `webhookSegment: 'telegram'` makes the registry route
`/channels/telegram/<publicKey>/webhook` to this adapter.

```ts
// packages/channels/src/telegram/descriptor.ts
export const TELEGRAM_DESCRIPTOR: ChannelKindDescriptor = {
  kind: 'TELEGRAM',
  label: 'Telegram bot',
  description: 'Customers message your Telegram bot; Telegram posts updates to the OCSO webhook.',
  mark: { code: 'TG', name: 'Telegram' },
  settingsSchema: z.toJSONSchema(TelegramSettings, { io: 'input' }) as Record<string, unknown>,
  secrets: [
    { key: 'botToken', label: 'Bot token', required: true, hint: 'From @BotFather.' },
    { key: 'webhookSecret', label: 'Webhook secret', required: true, generate: 'client',
      hint: 'Pass the same value as secret_token when you call setWebhook.' },
  ],
  setupSteps: [
    'Call setWebhook on the Bot API with url = the webhook URL above and secret_token = the webhook secret you saved.',
    'Send your bot a message; the channel card shows the last inbound time.',
  ],
  inboundWebhook: true,
  webhookSegment: 'telegram',
  webhookEvents: 'messages',
  embeddable: false,
};

// packages/channels/src/telegram/capabilities.ts
const MB = 1024 * 1024;
export const TELEGRAM_CAPABILITIES: ChannelCapabilities = Object.freeze<ChannelCapabilities>({
  inboundParts: ['TEXT', 'IMAGE', 'DOCUMENT'],
  outboundParts: ['TEXT'], // start with text; add media once render/send handle it
  maxTextLength: 4096,
  markdown: 'none',
  streaming: false,
  deliveryReceipts: false,
  interactive: false,
  maxMediaBytes: { IMAGE: 20 * MB, AUDIO: 0, VIDEO: 0, DOCUMENT: 20 * MB },
  allowedMimeTypes: { IMAGE: ['image/jpeg', 'image/png', 'image/webp'], AUDIO: [], VIDEO: [], DOCUMENT: ['application/pdf'] },
  sessionWindowHours: null, // no customer-service window
  identityKinds: ['telegram_user'],
});
```

## 4. Verify and parse inbound

`verifyRequest` runs before anything is parsed or stored. Compare secrets in constant time with the
shared helper. It may return a `Promise` when verification needs the network, for example a bearer JWT
checked against the provider's published keys (see `packages/channels/src/teams/verification.ts`); the
API awaits it either way. `parseInbound` turns one webhook body into canonical messages. The
`externalMessageId` is the idempotency key: the core drops a second delivery of the same id.

```ts
// packages/channels/src/telegram/verify.ts
export function verifyTelegramRequest(req: RawHttpRequest, config: ChannelRuntimeConfig): VerificationResult {
  if (req.method !== 'POST') return { kind: 'rejected', status: 400, reason: 'no handshake for this channel' };
  const header = req.headers['x-telegram-bot-api-secret-token'];
  if (!header) return { kind: 'rejected', status: 401, reason: 'missing secret token' };
  return equalSecrets(header, config.secrets['webhookSecret'] ?? '')
    ? { kind: 'verified' }
    : { kind: 'rejected', status: 403, reason: 'secret token mismatch' };
}

// packages/channels/src/telegram/inbound.ts
export function parseTelegramUpdate(rawBody: Buffer | null, now: () => Date): InboundEnvelope {
  const update = TelegramUpdate.safeParse(JSON.parse(rawBody?.toString('utf8') ?? 'null'));
  const message = update.success ? update.data.message : undefined;
  if (!message || message.chat.type !== 'private') return { messages: [], statuses: [], ignored: 1 };
  const parts: InteractionPart[] = [];
  if (message.text) parts.push({ type: 'TEXT', text: message.text });
  const photo = message.photo?.at(-1); // largest size
  if (photo) {
    parts.push({ type: 'IMAGE', ...(message.caption ? { caption: message.caption } : {}),
      media: { mimeType: 'image/jpeg', status: 'PENDING', source: { channel: 'TELEGRAM', externalId: photo.file_id } } });
  }
  return {
    messages: parts.length ? [{
      externalMessageId: `${message.chat.id}:${message.message_id}`,
      identityKind: 'telegram_user',
      identityValue: String(message.from.id),
      alternateIdentities: [],
      profileName: message.from.first_name,
      receivedAt: new Date(message.date * 1000),
      parts,
    }] : [],
    statuses: [],
    ignored: parts.length ? 0 : 1,
  };
}
```

`TelegramUpdate` is a zod schema of the fields you read. Anything you do not handle (edited messages,
callback queries, group chats) is counted in `ignored`, never thrown.

`telegram_user` values are numeric ids, which the generic list masking would take for phone numbers.
Implement `displayIdentity(identityKind, value)` on the adapter to show them your way (for example
`telegram · …4321`), returning `null` for identity kinds that are not yours.

## 5. Media, render and send

`fetchMedia` downloads what `parseInbound` marked `PENDING`. The core then re-checks the bytes against
your capabilities and stores them. Throw `ChannelMediaError` with a reason; `too_large` and
`type_not_allowed` mark the part rejected, network errors retry.

`render` receives only customer-safe parts that your `outboundParts` allow. `send` makes one provider
call per rendered payload and maps provider errors to `SendResult`. Return `retriable: true` for rate
limits and 5xx; the queue retries with backoff.

```ts
// packages/channels/src/telegram/render.ts
export function renderTelegram(parts: readonly InteractionPart[]): RenderedOutbound[] {
  return parts.flatMap((part, index) =>
    part.type === 'TEXT'
      ? chunkText(part.text, TELEGRAM_CAPABILITIES.maxTextLength).map((text) => ({ kind: 'TELEGRAM' as const, payload: { text }, partIndexes: [index] }))
      : [],
  );
}

// packages/channels/src/telegram/send.ts
export async function sendTelegram(target: OutboundTarget, message: RenderedOutbound, ctx: { config: ChannelRuntimeConfig; fetch: ChannelFetch }): Promise<SendResult> {
  const settings = TelegramSettings.parse(ctx.config.settings);
  const token = ctx.config.secrets['botToken'] ?? '';
  const res = await ctx.fetch(`${settings.apiBaseUrl}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // In a private chat the chat id equals the user id, which is the identity parseInbound recorded.
    body: JSON.stringify({ chat_id: target.identityValue, text: message.payload['text'] }),
    signal: AbortSignal.timeout(settings.requestTimeoutMs),
  });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: { message_id?: number }; description?: string } | null;
  if (res.ok && body?.ok && body.result?.message_id !== undefined) {
    return { ok: true, externalMessageId: `${target.identityValue}:${body.result.message_id}` };
  }
  const retriable = res.status === 429 || res.status >= 500;
  return sendFailure(retriable ? 'provider_unavailable' : 'provider_error', redactSecrets(body?.description ?? `HTTP ${res.status}`, [token]), retriable);
}
```

The bot token is part of the URL path here, so never put the URL in an error message. `redactSecrets`
masks the token if the provider echoes it. `ctx.fetch` is the `deps.fetch` your factory received: the
host's SSRF-guarded egress, which reaches `api.telegram.org` and refuses internal addresses unless the
Tech admin allowlisted them. Never call the global `fetch`.

Optionally implement `checkConnection` with read-only calls (Telegram's `getMe` and `getWebhookInfo`) to
get a **Test connection** button.

## 6. Export and register

```ts
// packages/channels/src/telegram/index.ts
export * from './adapter.js';
export { TELEGRAM_DESCRIPTOR } from './descriptor.js';

// packages/channels/src/index.ts
export * from './telegram/index.js';

// packages/bootstrap/src/first-party.ts — the one registration line
{ name: '@ocso/channels', channels: [createTwilioWhatsAppAdapter, createWhatsAppAdapter, createWebChatAdapter, createTelegramAdapter] },
```

`adapter.ts` is the class and factory from the skeleton in [channels.md](channels.md#skeleton),
calling the functions above; the factory takes `{ fetch, now }` and falls back to `NO_NETWORK`, never to
the global `fetch`. The api, the worker and the seed pick the adapter up from the one composition root.
After a rebuild, **Connections & models → Channels → Add channel** lists "Telegram bot", renders its
settings and secret fields, and after saving shows the webhook URL and your setup steps; conversations
carry the `TG` badge.

Templates and the widget are opt-in: implement the template methods and describe `templates` for
provider-reviewed message templates (the Message templates page and the composer's Template mode
follow), or set `embeddable: true` with `embed` hooks to serve customers through OCSO's widget.

## 7. Tests and docs

- Add the adapter to the `adapters` array in `packages/channels/test/adapters-contract.test.ts`, with
  a `tgConfig()` helper in `test/helpers/`. That runs the shared contract checks.
- Add recorded-shape fixtures under `test/fixtures/telegram/` and one test file per concern, following
  the `twilio-*.test.ts` files: config validation, verification (missing, wrong and right secret token),
  inbound parsing (text, photo, ignored updates), render (chunking at 4096), send (success, 429, 400,
  token redaction) with a fake `fetch`.
- Add a case to `packages/channels/test/registry.test.ts` if your descriptor uses something new.
- For an end-to-end check through the real API, copy `apps/api/test/int/twilio-whatsapp.int.test.ts`
  and point the adapter's `apiBaseUrl` at a local stub. Allowlist the stub's host first
  (`PATCH /v1/settings/deployment { egressAllowedInternalHosts: ['127.0.0.1'] }`): the egress guard
  refuses loopback otherwise.
- Run `pnpm lint`, `pnpm typecheck` and `pnpm test`.
- Document the operator steps in `docs/operations/setup-guide.md` §3, including the `setWebhook` call
  with `url` = the webhook URL OCSO shows and `secret_token` = the webhook secret.
