# @winsendotai/ocso-plugin-sdk

Types, a few small helpers and a conformance checker for building plugins for
[OCSO](https://github.com/winsenlabs/ocso), the open customer service orchestrator.

```sh
npm install @winsendotai/ocso-plugin-sdk
```

The package has no runtime dependencies. It is ESM only and needs Node 20 or later. `require()` of it works
without a flag on Node 22.12+ (and 20.19+); on older Node 20 releases use `import`. OCSO loads a plugin the way Node's
`import()` resolves it (`exports`, else `main`); a plugin built as CommonJS may export it as `module.exports`,
`exports.plugin` or TypeScript's `exports.default`. Jest needs ESM mode
(`node --experimental-vm-modules`) or `transformIgnorePatterns: ['node_modules/(?!@winsendotai/)']`.

## What a plugin is

An OCSO plugin is an npm package whose default export describes what it adds to OCSO's
registries. OCSO loads the plugins the operator lists **in-process** at start-up, in the api
and in the worker. A plugin therefore runs with OCSO's full trust. Everything a kind shows in
the admin UI (forms, labels, badges, setup steps) is data that the plugin describes. OCSO
renders it with generic forms, so a plugin never ships web UI.

```ts
import { definePlugin } from '@winsendotai/ocso-plugin-sdk';

export default definePlugin({
  apiVersion: 1,
  name: '@acme/ocso-channel-line', // by convention, the npm package name
  channels: [createLineAdapter],
});
```

## The four plugin kinds (plugin API version 1)

| key | contributes | selected by |
|---|---|---|
| `channels` | `ChannelAdapterFactory[]`: `(deps) => ChannelAdapter`. Each factory gets the SSRF-guarded egress `fetch` and a clock. | the admin adds a channel of that kind |
| `modelProviders` | `ProviderDefinition[]`: settings/credentials as zod schemas, capabilities, provider options, catalog mapping, adapter factory | the admin adds a model provider of that kind |
| `alertDestinations` | `AlertDestinationFactory[]`: `(deps) => AlertDeliveryAdapter`. Each factory gets the egress `fetch`, an SMTP transport factory and the deployment email sender. | the admin adds a notification destination |
| `emailDrivers` | `EmailDriverDefinition[]` | the operator sets `EMAIL_DRIVER=<name>` |

**Internal for now:** OCSO also has blob, secrets, queue, deployment and audit-store drivers
and tool providers. Their contracts depend on OCSO's database and configuration packages, so
plugins cannot contribute them in API version 1. `checkPlugin` and OCSO's loader refuse a
plugin that tries. External tools reach OCSO through MCP servers, which admins add at runtime.

Kinds are upper snake case (`LINE`, `ACME_SMS`, 2 to 40 characters). Driver names are lower
case (`postmark`). The patterns are exported as `CHANNEL_KIND_PATTERN`, `PROVIDER_KIND_PATTERN`,
`DESTINATION_KIND_PATTERN` and `DRIVER_NAME_PATTERN`.

## A complete minimal channel plugin

An "ECHO" channel. Anything posted to its webhook is answered through the configured URL.

```ts
import { definePlugin, pluginError, type ChannelAdapter, type ChannelAdapterDeps } from '@winsendotai/ocso-plugin-sdk';

function createEchoAdapter(deps: ChannelAdapterDeps): ChannelAdapter {
  return {
    kind: 'ECHO',
    describe: () => ({
      kind: 'ECHO',
      label: 'Echo',
      description: 'Posts replies to a URL you choose.',
      mark: { code: 'EC', name: 'Echo' },
      settingsSchema: { type: 'object', properties: { replyUrl: { type: 'string', title: 'Reply URL' } }, required: ['replyUrl'] },
      secrets: [{ key: 'token', label: 'Token', required: true, hint: 'Sent as x-echo-token both ways.', generate: 'client' }],
      setupSteps: ['Point your system at the webhook URL below and send the token as x-echo-token.'],
      inboundWebhook: true, // POST /channels/echo/<publicKey>/webhook
      embeddable: false,
    }),
    capabilities: () => ({
      inboundParts: ['TEXT'],
      outboundParts: ['TEXT'],
      maxTextLength: 2000,
      markdown: 'none',
      streaming: false,
      deliveryReceipts: false,
      interactive: false,
      maxMediaBytes: { IMAGE: 0, AUDIO: 0, VIDEO: 0, DOCUMENT: 0 },
      allowedMimeTypes: { IMAGE: [], AUDIO: [], VIDEO: [], DOCUMENT: [] },
      sessionWindowHours: null,
    }),
    validateConfig: (settings, secrets) => (secrets['token'] ? [] : ['A token is required']),
    verifyRequest: (req, config) =>
      req.headers['x-echo-token'] === config.secrets['token'] ? { kind: 'verified' } : { kind: 'rejected', status: 401, reason: 'bad token' },
    parseInbound(req) {
      const body = JSON.parse(req.rawBody?.toString('utf8') ?? '{}') as { id?: string; from?: string; text?: string };
      if (!body.id || !body.from || !body.text) throw pluginError('validation', 'echo_payload_invalid', 'id, from and text are required');
      return {
        messages: [{ externalMessageId: body.id, identityKind: 'echo_user', identityValue: body.from, alternateIdentities: [], receivedAt: deps.now(), parts: [{ type: 'TEXT', text: body.text }] }],
        statuses: [],
        ignored: 0,
      };
    },
    fetchMedia: () => Promise.reject(pluginError('validation', 'echo_no_media', 'Echo carries text only')),
    render: (parts) => parts.flatMap((p, i) => (p.type === 'TEXT' ? [{ kind: 'ECHO', payload: { text: p.text }, partIndexes: [i] }] : [])),
    async send(target, message, config) {
      const res = await deps.fetch(String(config.settings['replyUrl']), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-echo-token': config.secrets['token'] ?? '' },
        body: JSON.stringify({ to: target.identityValue, text: message.payload['text'] }),
      });
      return res.ok
        ? { ok: true, externalMessageId: crypto.randomUUID() }
        : { ok: false, errorCode: `http_${res.status}`, message: 'reply rejected', retriable: res.status >= 500 };
    },
  };
}

export default definePlugin({ apiVersion: 1, name: '@acme/ocso-channel-echo', channels: [createEchoAdapter] });
```

The OCSO repository has a fuller example, a signed JSON-webhook channel with tests:
[`examples/ocso-plugin-example-channel`](https://github.com/winsenlabs/ocso/tree/main/examples/ocso-plugin-example-channel).

### Rules the host relies on

- **Network:** channels and alert destinations reach the network only through the `fetch` they
  are given. OCSO passes its SSRF-guarded egress: public HTTPS hosts plus the operator's
  internal allowlist. Model provider adapters are not given a guarded fetch today.
- **Errors:** throw `pluginError(category, code, message, details?)`. OCSO turns the marker into
  its own typed error, so `authentication` becomes a 401, `validation` a 400, and
  `provider_unavailable` or `timeout` are retried. A plain `Error` becomes a 500. `details` must
  never contain secrets. `isPluginError()` recognizes the marker by shape, so it works across
  copies of this package.
- **Email drivers:** `EmailEnv` lists only the variables OCSO itself parses. Read your driver's
  own settings from `process.env` in `resolve`, and report problems with `ctx.problem(...)`. Throw
  `pluginError(...)` from `send` to say how OCSO should treat a failure: `authentication`,
  `authorization`, `validation` and `policy_denied` are permanent (no retry); `provider_rate_limited`,
  `capacity`, `provider_unavailable`, `tool_unavailable` and `timeout` are retried with backoff. An
  integer `details.status` is kept as the provider's status code. Any other error is treated as
  transient and retried until the attempts run out.
- **Web chat embedding:** an `embeddable` channel implements `embed` (`EmbeddedChat`). Its
  `openSession` and `identify` are async (they may verify tokens against a JWKS endpoint).
  `mintSessionPass` and `openUserToken` are optional.
- **Model providers** describe their settings with zod 4 schemas (`z.ZodType`), which OCSO turns
  into form fields. Install `zod@^4` as a dependency of a provider plugin. The other kinds do
  not need zod at runtime. The SDK's type declarations do mention zod, so a project that
  type-checks libraries (`skipLibCheck: false`) needs zod installed as a dev dependency.
- The contract types mention Node's `Buffer` (`RawHttpRequest.rawBody`), so TypeScript users
  need `@types/node`.

## Testing a plugin

```ts
import { checkPlugin } from '@winsendotai/ocso-plugin-sdk/testing';
import plugin from '../src/index.js';

test('OCSO accepts the plugin', () => {
  expect(checkPlugin(plugin)).toEqual([]);
});
```

`checkPlugin(plugin)` returns every problem OCSO would refuse the plugin for at start-up:
- the API version, the name (at most 214 characters, not in the `@ocso/` scope, which is
  reserved for OCSO's own plugins) and internal-only contribution keys (other extra keys are
  ignored, as OCSO ignores them),
- kind and driver-name patterns and duplicates,
- the channel mark code (1 to 3 letters or digits),
- `embeddable` exactly when there are `embed` hooks (the descriptor must set `embeddable`
  to `true` or `false`),
- message templates: described exactly when `listTemplates`, `createTemplate` and
  `sendTemplate` are all implemented,
- webhook URL segments,
- alert destination events (a non-empty subset of `ALERT_EVENTS`),
- missing methods.

It runs the same checks as OCSO's registries. The OCSO repository runs both over every
first-party contribution and requires the same verdict. `checkPlugin` builds each channel and
alert destination with stand-in dependencies that have no network access, so factories must not
do I/O while they are being built. It cannot see a clash with another installed plugin's kind.
OCSO reports those at start-up.

`CHECK_CHANNEL_DEPS` and `CHECK_ALERT_DEPS` (from `/testing`) are those stand-ins, in case you
want to build your adapter the same way in your own tests.

## Installing a plugin into OCSO

Operators install plugins at exact versions and list them in `OCSO_PLUGINS`
(`@acme/ocso-channel-line@1.2.3,@acme/ocso-email-postmark@0.4.0`). The usual way is a derived
image of the api and the worker with the packages installed into `/app/plugins`. OCSO refuses
to start when:
- an installed version differs from the pinned one,
- a plugin's `apiVersion` is not one it runs,
- a plugin's name clashes with another plugin's name,
- a plugin's contributions fail these checks.

Tech admins see the loaded plugins under System → Plugins. See
[`docs/plugins/installing.md`](https://github.com/winsenlabs/ocso/blob/main/docs/plugins/installing.md).

A plugin runs in-process with full access. Install only code you trust, and pin versions.

## Versioning

- `apiVersion` (and `OCSO_PLUGIN_API_VERSION`) is the contract handshake. It changes only for a
  breaking change to a plugin contract. An OCSO release states which plugin API versions it
  runs.
- The package follows semver. While it is 0.x, minor releases may add optional members to the
  contracts (for example a new optional adapter method, or a new optional field OCSO passes
  in). Anything that would break a plugin that compiled against an earlier 0.x of the same
  `apiVersion` raises `apiVersion`.
- The contract types are copies of OCSO's internal contracts. A type-level test in the OCSO
  repository fails when the two drift, so an SDK release always matches the OCSO release it
  names.

## License

Apache-2.0
