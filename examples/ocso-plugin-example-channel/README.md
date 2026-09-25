# Example OCSO plugin: signed JSON-webhook channel

This is a small but real OCSO channel plugin, built only on `@winsendotai/ocso-plugin-sdk`. It is
not published. Any system that can send and receive signed JSON over HTTPS can talk to OCSO
through it.

- **Kind** `JSON_WEBHOOK`, badge `JS`.
- **Settings:** `outboundUrl`, an https endpoint that OCSO posts replies to.
- **Secret:** `signingSecret`, a shared HMAC-SHA256 key of at least 16 characters.

## Protocol

**Inbound** (your system to OCSO): `POST /channels/json-webhook/<publicKey>/webhook`, signed with
`x-ocso-signature: sha256=<hex HMAC-SHA256(raw body, signingSecret)>`.

```json
{
  "messages": [{ "id": "m-1", "from": "user-42", "name": "Priya", "text": "Hello", "sentAt": "2026-09-23T10:00:00Z" }],
  "statuses": [{ "id": "<id OCSO sent>", "status": "delivered" }]
}
```

Status values are `sent`, `delivered`, `read` and `failed`. Unknown statuses are counted as
ignored.

**Outbound** (OCSO to your system): `POST <outboundUrl>` with `{ "id", "to", "text" }`, signed the
same way. A 2xx response means accepted. A 429 or 5xx response is retried. Choice questions
arrive as numbered text.

## Build and test

```sh
pnpm --filter @ocso-examples/ocso-plugin-example-channel build
pnpm vitest run --project unit examples/ocso-plugin-example-channel
```

The test runs `checkPlugin` from `@winsendotai/ocso-plugin-sdk/testing`. It also covers:
- signature checks,
- inbound parsing,
- chunked rendering,
- signed sends through the injected `fetch`,
- typed `pluginError`s.

## Install into OCSO

Install the package into the plugins directory at an exact version and list it in
`OCSO_PLUGINS`. See `docs/guides/extending/install-a-plugin.md`. The package's default export is the plugin:

```ts
export default definePlugin({ apiVersion: 1, name: '@ocso-examples/ocso-plugin-example-channel', channels: [createJsonWebhookAdapter] });
```

At runtime it imports `@winsendotai/ocso-plugin-sdk`, for `definePlugin` and `pluginError`. That
package must therefore be resolvable from where the plugin is installed. A normal
`npm install` puts it there, because it is a regular dependency.
