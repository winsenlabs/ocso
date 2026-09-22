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

Two layers. A **definition** is what you register. It describes the provider to the admin form and
creates adapters. An **adapter** is one configured provider that the runtime calls.

`packages/model-providers/src/providers/definition.ts`, trimmed:

```ts
export interface ProviderDefinition<S = unknown, C = unknown> {
  readonly kind: ProviderKind;
  readonly label: string;
  /** Dev-only providers are registered only when explicitly enabled (ADR-015). */
  readonly devOnly: boolean;
  /** Non-secret settings the Tech Admin enters (validated at save time and on create). */
  readonly settingsSchema: z.ZodType<S>;
  /** Secret fields, resolved from SecretStore by trusted code only. */
  readonly credentialsSchema: z.ZodType<C>;
  capabilities(model: string, settings: S): ModelCapabilities;
  /** Cache directives, cache keys and reasoning overrides for one request. */
  providerOptions(model: string, request: ModelRequest, settings: S): ProviderOptionsPlan;
  create(config: ProviderRuntimeConfig, deps: AdapterDeps): ModelProviderAdapter;
}
```

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

export function createDefaultRegistry(options: DefaultRegistryOptions): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const definition of PRODUCTION_PROVIDERS) registry.register(definition);
  if (options.enableDevProviders) registry.register(devScriptedProvider);
  return registry;
}
```

`packages/bootstrap/src/model-adapters.ts` calls this for the api and the worker, passing
`OCSO_ENABLE_DEV_PROVIDERS`. The kind must also be in `PROVIDER_KINDS` in `contract/types.ts`.

## What the core does for you

**The call path.** `createAiSdkAdapter` (`src/core/adapter.ts`) implements `stream`, `generate` and
`health` on top of the Vercel AI SDK. A provider module supplies only what differs, as an
`AiSdkAdapterSpec` (`src/core/spec.ts`): a model-instance factory, a `ProviderOptionsPlan` (request-level
options plus the marker to attach at each prompt-compiler cache breakpoint, and the provider's
breakpoint limit), the response headers carrying the request id, and an optional usage fix-up. The core
translates prompts, media and tool schemas, streams, normalizes usage per step, measures time to first
token, and maps every failure to a `DomainError` with a fixed message and scrubbed details. Tools are
schema-only: the model proposes calls and OCSO authorizes and runs them (ADR-014).

**Administration.** `GET /v1/model-providers/kinds` turns each definition's zod schemas into form field
descriptors (`packages/application/src/models/field-descriptors.ts`). The web app renders the provider
form from them, so a new provider needs no form code. Credentials are written to the SecretStore and
never returned. **Test** runs your `health()` probe plus one small real `generate()` call.

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
  kind: 'ACME', // add to PROVIDER_KINDS first
  label: 'Acme AI',
  devOnly: false,
  settingsSchema,
  credentialsSchema,
  capabilities: (model, settings) => withOverrides(acmeCapabilities(model), model, settings.capabilityOverrides),
  providerOptions: () => ({}), // no cache directives documented
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

Then export it from `src/index.ts` and add it to `PRODUCTION_PROVIDERS`.

## Tests to copy

- `packages/model-providers/test/contract/provider-contract.ts`: the shared contract suite. Each
  provider supplies a `ContractFixture` with recorded provider-format stream, generate and error
  responses, and the suite checks text and tool-call streaming, usage mapping, request ids, cache
  directives in the request body, tool ordering, and that credentials never appear in errors. See
  `anthropic.contract.test.ts` and its fixture file for the pattern.
- `packages/model-providers/test/registry.test.ts`: registration, duplicates, dev-only gating.
- `packages/model-providers/test/core/`: the shared core, if you change it.
- `apps/api/test/int/models.int.test.ts`: provider and profile administration through the API.

## Limits today

- `PROVIDER_KINDS` is a closed union, and the application validates provider kinds against it with
  `z.enum` (`packages/application/src/models/inputs.ts`) as well as against the registry.
- The web app keeps its own copy of the provider kinds as a `z.enum` (`apps/web/lib/api/models.ts`),
  plus per-kind logo text and caching descriptions (`apps/web/components/connections/models/meta.ts`,
  `apps/web/components/system/provider-health.tsx`). A new kind needs edits there today, or the web
  app rejects the API response.
- Provider behaviour is verified against recorded provider-format responses. Live calls need real
  credentials, which CI does not have.
- **In progress:** model discovery (an optional `listModels` on the adapter, under `src/discovery/`)
  and an open-source model catalog for prices (`src/catalog/`, `src/pricing/`) are being written as
  this is published. Their catalog mapping currently switches on provider kind, which will move onto
  the definition.
