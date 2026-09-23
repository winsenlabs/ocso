# Model providers

A model provider plugin teaches OCSO to call one model API. Agents never name a provider. They use a
logical model profile (`support-primary`, `summarizer`, …) that a Platform Tech Admin maps to a
provider, a model and ordered fallbacks. The provider plugin is what turns that target into an API
call, with the provider's own prompt-caching controls.

Shipped providers, all in `packages/model-providers/src/providers/`:

| Kind | Directory | SDK | Prompt caching |
|---|---|---|---|
| `BEDROCK` | `bedrock/` | `@ai-sdk/amazon-bedrock` (Converse) | explicit cache points after the stable prefix |
| `VERTEX` | `vertex/` | `@ai-sdk/google-vertex` (Gemini; Claude via `/anthropic`) | implicit prefix caching for Gemini; cache control for Claude |
| `FOUNDRY` | `foundry/` | `@ai-sdk/azure` (OpenAI-family deployments); `@ai-sdk/anthropic` (Claude) | prompt cache key; cache control for Claude |
| `OPENAI` | `openai/` | `@ai-sdk/openai` (Responses API) | automatic, plus a prompt cache key per agent prefix |
| `ANTHROPIC` | `anthropic/` | `@ai-sdk/anthropic` | explicit cache-control breakpoints (at most 4) |
| `SARVAM` | `sarvam/` | `@ai-sdk/openai-compatible` | no documented control; reported as unverified |
| `DEV_SCRIPTED` | `dev-scripted/` | scripted, no network | simulated; development and tests only (ADR-015) |

The reasoning behind each choice is in ADR-006
([PM/ARCHITECTURE-DECISIONS.md](../../PM/ARCHITECTURE-DECISIONS.md)); the package README
([packages/model-providers/README.md](../../packages/model-providers/README.md)) covers the shared core's
invariants and error mapping. Operator settings per provider are in
[docs/operations/setup-guide.md §2](../operations/setup-guide.md#2-model-providers-and-profiles-tech-admin).

## The contract

Two layers. A **definition** is what you register. It carries everything OCSO knows about the kind (the admin
form, the UI's mark and caching wording, how the model catalogs spell its model ids) and creates adapters. An
**adapter** is one configured provider that the runtime calls. Nothing outside the plugin names a kind: provider
kinds are open strings, and the registry decides which kinds a deployment accepts.

`packages/model-providers/src/providers/definition.ts`, trimmed:

```ts
export interface ProviderDefinition<S = unknown, C = unknown> {
  /** UPPER_SNAKE_CASE (`PROVIDER_KIND_PATTERN`); stored on provider rows and usage. */
  readonly kind: ProviderKind; // = string
  readonly label: string;
  /** Short mono mark the admin UI shows in place of a vendor logo, e.g. `OAI` (1–4 characters). */
  readonly mark: string;
  /** One line on what the adapter does for prompt caching, shown on provider cards. */
  readonly cachingSummary: string;
  /** Registered only when explicitly enabled (ADR-015); usage never priced. */
  readonly devOnly: boolean;
  /** Non-secret settings the Tech Admin enters (validated at save time and on create). */
  readonly settingsSchema: z.ZodType<S>;
  /** Secret fields, resolved from SecretStore by trusted code only. */
  readonly credentialsSchema: z.ZodType<C>;
  /** Where the open-source model catalogs list this provider's models (ADR-027). Absent: manual prices only. */
  readonly catalog?: ProviderCatalogMapping;
  capabilities(model: string, settings: S): ModelCapabilities;
  /** Cache directives, cache keys and reasoning overrides for one request. */
  providerOptions(model: string, request: ModelRequest, settings: S): ProviderOptionsPlan;
  /** How one model caches prompts, in words for the admin UI. Absent: derived from capabilities. */
  describeCaching?(model: string, settings: S): PromptCachingDescription;
  /** The underlying model when the id alone does not say (a deployment name), for catalog lookups. */
  baseModel?(model: string, settings: S): string | null;
  create(config: ProviderRuntimeConfig, deps: AdapterDeps): ModelProviderAdapter;
}

export interface ProviderCatalogMapping {
  /** Catalog providers `candidates` uses; the catalog snapshots keep only these providers' models. */
  readonly providers: { 'models.dev'?: readonly string[]; litellm?: readonly string[] };
  /** models.dev provider whose models stand in when the provider has no listing endpoint. */
  readonly listingProvider?: string;
  /** Exact catalog keys for one model id, models.dev first. [] = the id says nothing about the model: not priced. */
  candidates(model: string, baseModel: string | null): CatalogCandidate[];
}
```

`PromptCachingDescription` is `{ mode, mechanism, effect: { '5m', '1h' } }`: the mode chip (`explicit`,
`key-based`, `implicit`, `unverified`, `none`), the mechanism in words, and what a profile's prefix cache
policy sends for each TTL. `describePromptCaching(capabilities, wording)` builds it from the model's
capabilities (so capability overrides are honoured) with your own wording; `keyBasedCaching` covers the
OpenAI family. Catalog keys are built with `modelsDevKey(provider, id)` and `liteLlmKey(provider, id)`.

`packages/model-providers/src/contract/types.ts`, trimmed:

```ts
export interface ModelProviderAdapter {
  readonly kind: ProviderKind;
  readonly providerId: string;
  capabilities(model: string): ModelCapabilities;
  /** Streams events; the final event is always `finish`. Throws DomainError (normalized). */
  stream(request: ModelRequest, model: string): AsyncIterable<ModelStreamEvent>;
  generate(request: ModelRequest, model: string): Promise<ModelResult>;
  health(model?: string): Promise<ProviderHealth>;
  /** Models this configuration can call, from the provider's own listing (ADR-027). Optional. */
  listModels?(options?: ListModelsOptions): Promise<ProviderModelInfo[]>;
}
```

`ModelCapabilities` declares image, file and audio input, tool calling, structured output, reasoning,
streaming, and `promptCaching` (`EXPLICIT`, `AUTOMATIC`, `UNSUPPORTED` or `UNVERIFIED`). Profiles are
checked against these before they can be saved. `NormalizedUsage` reports cached and cache-write tokens
as `null` when the provider did not report them, never as zero.

## How one is registered

`packages/model-providers/src/registry.ts`:

```ts
export const PRODUCTION_PROVIDERS: readonly ProviderDefinition[] = [
  bedrockProvider, vertexProvider, foundryProvider, openAiProvider, anthropicProvider, sarvamProvider,
];
/** Every provider this package ships. A new provider is one definition file plus one line here. */
export const FIRST_PARTY_PROVIDERS = [...PRODUCTION_PROVIDERS, devScriptedProvider];

export function createRegistry(definitions, options: { enableDevProviders: boolean }): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const d of definitions) if (!d.devOnly || options.enableDevProviders) registry.register(d);
  return registry;
}
export const createDefaultRegistry = (options) => createRegistry(FIRST_PARTY_PROVIDERS, options);
```

`register()` rejects a kind that does not match `PROVIDER_KIND_PATTERN` and a kind registered twice. The
api and the worker get their registry from `packages/bootstrap`, passing `OCSO_ENABLE_DEV_PROVIDERS`.
Adding a provider needs no edit to the application, the API, the database schema or the web app: inputs
accept any well-formed kind and the services check it against the registry (`provider_kind_not_available`).

## What the core does for you

**The call path.** `createAiSdkAdapter` (`src/core/adapter.ts`) implements `stream`, `generate` and
`health` on top of the Vercel AI SDK. A provider module supplies only what differs, as an
`AiSdkAdapterSpec` (`src/core/spec.ts`): a model-instance factory, a `ProviderOptionsPlan` (request-level
options plus the marker to attach at each prompt-compiler cache breakpoint, and the provider's
breakpoint limit), the response headers carrying the request id, and an optional usage fix-up. The core
translates prompts, media and tool schemas, streams, normalizes usage per step, measures time to first
token, and maps every failure to a `DomainError` with a fixed message and scrubbed details. Tools are
schema-only: the model proposes calls and OCSO authorizes and runs them (ADR-014).

**Administration.** `GET /v1/model-providers/kinds` (providers.read) returns, per registered kind, its
`label`, `mark`, `cachingSummary`, `devOnly` and the settings and credential form field descriptors built
from its zod schemas (`packages/application/src/models/field-descriptors.ts`). Profile targets and policy
checks carry each target's `caching` description from `describeCaching`. The web app renders only from
these, so a new provider needs no web code; a kind the web build has never seen still parses and gets a
generic mark. Credentials are written to the SecretStore and never returned. **Test** runs your `health()`
probe plus one small real `generate()` call.

**Pricing.** The model catalog (`src/catalog/`) knows no provider kind. It looks models up through the
definition's `catalog` mapping and `baseModel`, keeps in its snapshots exactly the catalog providers the
first-party definitions declare, and uses `listingProvider` as the model list for providers without a
listing endpoint. Dev-only providers are never priced.

**Runtime.** `CachedProviderAdapterSource` (`packages/bootstrap/src/model-adapters.ts`) builds one
adapter per provider configuration and reuses it until the row changes, so token caches inside the
adapter survive between calls. The model gateway in `packages/agent-runtime` applies the profile's
fallbacks, retries and timeouts (`src/policy/fallback-policy.ts` decides when a fallback is allowed) and
records usage per request for the telemetry and cost screens.

**Policy.** The deployment settings (provider allowlist, residency zone, cross-provider and
cross-region fallback) are checked for every profile target before a profile is saved.

## Skeleton

An OpenAI-compatible provider is the shortest path; `sarvam/definition.ts` is a complete example.

```ts
// packages/model-providers/src/providers/acme/definition.ts
const settingsSchema = z.object({
  baseURL: z.url({ protocol: /^https$/ }).default('https://api.acme.example/v1'),
  ...commonSettingsShape, // healthModel, capabilityOverrides
});
const credentialsSchema = z.object({ apiKey: requiredSecret('Acme API key') });

export const acmeProvider: ProviderDefinition<z.infer<typeof settingsSchema>, z.infer<typeof credentialsSchema>> = {
  kind: 'ACME',
  label: 'Acme AI',
  mark: 'ACM',
  cachingSummary: 'no documented control',
  devOnly: false,
  settingsSchema,
  credentialsSchema,
  // Only if models.dev / LiteLLM list Acme; otherwise omit (manual prices only).
  catalog: {
    providers: { 'models.dev': ['acme'] },
    listingProvider: 'acme',
    candidates: (model) => [modelsDevKey('acme', model)],
  },
  capabilities: (model, settings) => withOverrides(acmeCapabilities(model), model, settings.capabilityOverrides),
  providerOptions: () => ({}), // no cache directives documented
  // describeCaching omitted: the wording is derived from capabilities().promptCaching.
  create(config, deps) {
    const { settings, credentials } = parseProviderConfig(acmeProvider, config);
    const acme = createOpenAICompatible({ name: 'acme', baseURL: settings.baseURL, apiKey: credentials.apiKey, includeUsage: true, ...fetchOption(deps) });
    return createAiSdkAdapter({
      kind: 'ACME',
      providerId: config.id,
      region: config.region,
      media: deps.media,
      capabilities: (model) => acmeProvider.capabilities(model, settings),
      languageModel: (model) => acme.chatModel(model), // a model instance, never a string id
      providerOptions: (model, request) => acmeProvider.providerOptions(model, request, settings),
      requestIdHeaders: ['x-request-id'],
      healthModel: settings.healthModel ?? 'acme-small',
      secrets: secretValues(config),
    });
  },
};
```

Then add it to `PRODUCTION_PROVIDERS` in `src/registry.ts` (and export it from `src/index.ts` if other code
needs it by name). If you declared new catalog providers, regenerate the vendored catalog snapshot
(`node scripts/refresh-model-catalog.mjs`) so it prices your models before the first catalog refresh.

## Tests to copy

- `packages/model-providers/test/contract/provider-contract.ts`: the shared contract suite. Each
  provider supplies a `ContractFixture` with recorded provider-format stream, generate and error
  responses, and the suite checks text and tool-call streaming, usage mapping, request ids, cache
  directives in the request body, tool ordering, and that credentials never appear in errors. See
  `anthropic.contract.test.ts` and its fixture file for the pattern.
- `packages/model-providers/test/registry.test.ts`: registration, open kinds, duplicates, dev-only gating,
  marks and per-model caching wording.
- `packages/model-providers/test/catalog/catalog.test.ts`: catalog keys per kind (exact ids, Bedrock region
  prefixes, Vertex `@default`, Foundry underlying models) through each definition's mapping.
- `packages/model-providers/test/core/`: the shared core, if you change it.
- `apps/api/test/int/models.int.test.ts`: provider and profile administration through the API.

## Limits today

- Providers are compiled in and registered in this package (`FIRST_PARTY_PROVIDERS`); there is no loader
  for providers published elsewhere yet.
- The catalog snapshots keep the catalog providers the first-party definitions declare. A provider
  registered from outside this package would also need its catalog providers passed to `buildSnapshot`.
- Provider behaviour is verified against recorded provider-format responses. Live calls need real
  credentials, which CI does not have.
- The Vertex and Bedrock model listings are built to their documented shapes and still owe a live check.
