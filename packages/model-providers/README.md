# @ocso/model-providers

Model-provider adapters for OCSO (docs/archive/specs/06, ADR-006, ADR-014, ADR-015). All six providers share one AI SDK v7
core. Each provider module supplies only its model factory, its provider-options builder (cache markers, cache
keys, reasoning) and its request-id/usage extractors.

```
src/
  contract/types.ts        ModelProviderAdapter, ModelRequest/Result, NormalizedUsage, ProviderKind (public contract)
  providers/definition.ts  ProviderDefinition: the plugin contract (forms, UI mark, caching wording, catalog mapping)
  core/                    shared AI-SDK path: prompt + tools translation, stream/generate, usage, errors, health
  providers/<name>/        bedrock, vertex, foundry, openai, anthropic, sarvam, dev-scripted
  catalog/, pricing/       open-source model catalog + price selection (ADR-027); no provider kind named there
  registry.ts              ProviderRegistry, FIRST_PARTY_PROVIDERS, createDefaultRegistry({ enableDevProviders })
```

Provider kinds are open strings (`PROVIDER_KIND_PATTERN`); the registry, not a union type, decides which kinds a
deployment accepts. Everything kind-specific lives on the definition: label, `mark`, `cachingSummary`,
`describeCaching(model, settings)`, `catalog` (catalog keys per model id), `baseModel(model, settings)` and
`devOnly`. A new provider is one `providers/<name>/definition.ts` plus one line in `FIRST_PARTY_PROVIDERS`
(see docs/guides/models/README.md).

## Using it

```ts
const registry = createDefaultRegistry({ enableDevProviders: process.env.OCSO_ENABLE_DEV_PROVIDERS === 'true' });
const adapter = registry.create(config /* ProviderRuntimeConfig with resolved secrets */, { media: blobMediaResolver });
for await (const event of adapter.stream(request, 'claude-sonnet-4-6')) { /* text-delta | tool-call | finish */ }
const health = await adapter.health(model); // never throws
```

- **Create one adapter per provider configuration and reuse it.** Token and credential caches live inside the
  adapter: the Vertex service-account token, the Entra ID token and the AWS credential chain.
  `registry.checkHealth(config, deps)` builds a throwaway adapter. It is meant for "Test connection" in the admin UI,
  not for periodic sampling.
- `settingsSchema` and `credentialsSchema` on each definition are zod schemas. Validate admin input with them at
  save time. `create()` validates again. Validation errors name fields only, never values.
- The AI SDK logs warnings (for example "temperature not supported") to the console. Adapters already return them
  on `ModelResult.warnings`, so set `globalThis.AI_SDK_LOG_WARNINGS = false` at process start.

### Invariants of the shared core (ADR-006)

- **Model instances only.** A string model id would route to the Vercel AI Gateway.
- **Instructions.** `instructions` holds one `SystemModelMessage` per compiler `SystemBlock`.
- **Media.** Media parts are resolved to bytes through `deps.media.resolve(blobKey)` inside the adapter. Blob keys
  never reach a provider.
- **Tools.** Tools are schema-only (`jsonSchema()`, no `execute`) and always resent. The core always passes
  `toolOrder: []`, so tools arrive sorted by name. The loop stops at `finishReason: 'tool-calls'`, and OCSO
  authorizes and executes the calls (ADR-014).
- **Retries and timeouts.** `maxRetries: 0`, because OCSO owns retry and fallback (`policy/fallback-policy.ts`). The
  core uses `timeout.totalMs = request.timeoutMs` plus the caller's `abortSignal`. If the consumer stops iterating a
  stream early, the provider request is aborted.
- **Telemetry.** SDK telemetry is off, because SDK spans would record prompts. OCSO emits its own spans.
- **Usage.** Usage is normalized per step with `normalizeUsage`. `null` means "not reported", never zero. Where an
  SDK reports `0` for a counter that the server never sent (Bedrock without caching, Chat Completions without
  `prompt_tokens_details`), the adapter checks `usage.raw` and reports `null` instead.
- **TTFT.** TTFT comes from the SDK's `finish-step.performance.timeToFirstOutputMs`, or else from the first text or
  tool delta. Non-streaming `generate()` reports `ttftMs: null`.
- **Errors.** Every failure becomes a `DomainError` with a fixed, safe message. `details` carries only `statusCode`,
  a sanitized `providerErrorCode`, `providerRequestId`, `retryAfterMs`, provider kind/id and model. The adapter never
  attaches raw bodies, URLs, request bodies or a `cause`. Credential values are scrubbed as a second line of defence.

| Failure | Category / code |
|---|---|
| 429 | `provider_rate_limited` / `provider_rate_limited`; `provider_quota_exhausted` for insufficient-quota bodies |
| 5xx, 409, 424, network (`ECONNRESET`…) | `provider_unavailable` (`provider_unavailable`, `provider_overloaded` for 529, `provider_unreachable`) |
| total timeout, 408, 504, connect timeout | `timeout` / `model_timeout` or `provider_timeout` |
| caller `abortSignal` | `timeout` / `model_request_cancelled` |
| 400 / 422 | `validation`: `provider_rejected_request`, `provider_context_length_exceeded`; content filter → `policy_denied` / `provider_content_filtered` |
| 401 / 403 | `authentication` / `authorization` |
| 404 | `not_found` / `provider_model_not_found` (wrong model or deployment) |
| schema-invalid structured output | `provider_unavailable` / `model_structured_output_invalid` |
| missing capability (image to a text model…) | `validation` / `model_capability_missing`, raised before any provider call |

## Provider setup (what the Tech admin enters)

Every provider also accepts two optional settings:

- `healthModel`: the model or deployment used by `health()` when no model is passed.
- `capabilityOverrides`: `{ [model]: Partial<ModelCapabilities> }`, which corrects the model-family heuristics.

### AWS Bedrock (`BEDROCK`)

- **Settings**
  - `region`, for example `ap-south-1`. It falls back to the provider record's region.
  - `authMode`: `ACCESS_KEYS` (default), `IAM_ROLE` or `API_KEY`.
  - Optional `baseURL` for a bedrock-runtime VPC endpoint.
- **Credentials**
  - `ACCESS_KEYS`: `accessKeyId` and `secretAccessKey`, plus an optional `sessionToken`. Create them for an IAM user
    in IAM → Users → Security credentials.
  - `IAM_ROLE`: none. The AWS default Node credential chain is loaded lazily: ECS task role, EC2 instance profile,
    IRSA, env or SSO. This is the recommended mode on ECS Fargate.
  - `API_KEY`: `apiKey`, a Bedrock API key (Bedrock console → API keys).
- **Model id:** a model or inference-profile id, for example `apac.anthropic.claude-sonnet-4-5-20250929-v1:0` or
  `amazon.nova-pro-v1:0`. Model access must be enabled in the Bedrock console for the region.
- **IAM permissions**
  - Grant `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream`. Converse and ConverseStream authorize
    against these two actions.
  - Scope them to `arn:aws:bedrock:<region>::foundation-model/*` and
    `arn:aws:bedrock:<region>:<account>:inference-profile/*`.
  - Cross-region inference profiles (`apac.`, `us.`, `global.`) also need the foundation-model ARNs in every
    destination region of the profile.
  - `API_KEY` mode additionally needs `bedrock:CallWithBearerToken`.
- **Streaming:** ConverseStream event-stream, contract-tested with binary event-stream fixtures that include
  in-stream `throttlingException`. `generate()` uses Converse.

### Google Vertex AI (`VERTEX`)

- **Settings**
  - `location`: `global` (default), `us`, `eu` or a region such as `asia-south1`.
  - `project`: defaults to the key's `project_id`.
  - `authMode`: `SERVICE_ACCOUNT_KEY` (default) or `APPLICATION_DEFAULT`, which uses google-auth-library ADC (GKE
    Workload Identity, GCE metadata server).
- **Credentials:** `serviceAccountJson`, the full JSON key file (IAM & Admin → Service Accounts → Keys → Add key →
  JSON). OCSO signs the RS256 JWT-bearer assertion itself and exchanges it at the key's `token_uri`, using the
  injected `fetch`. The token is cached until one minute before expiry.
- **Roles:** Vertex AI User (`roles/aiplatform.user`) on the project. Claude also has to be enabled in Model Garden
  (Anthropic partner models), and so does any Gemini model that requires it.
- **Routing:** model ids that contain `claude` use `createGoogleVertexAnthropic` (rawPredict/streamRawPredict).
  Every other id uses `createGoogleVertex` (Gemini, `v1beta1 …:generateContent`).

### Microsoft Foundry (`FOUNDRY`)

- **Settings**
  - `resourceName` (→ `https://<resource>.services.ai.azure.com`) or `endpoint`, which can be a resource URL or a
    project URL such as `https://<res>.services.ai.azure.com/api/projects/<p>`.
  - `authMode`: `API_KEY` (default) or `ENTRA_ID`.
  - `deployments`: `{ "<deployment name>": { modelFamily: "openai" | "anthropic" | "other", model?, api?, explicitCacheBreakpoints? } }`.
  - `defaultModelFamily` (default `openai`).
  - `storeResponses` (default `false`).
- **Model id:** the deployment name.
- **Endpoints used**

  | Family | Endpoint | SDK path |
  |---|---|---|
  | `openai` | `<endpoint>/openai/v1/responses` | `@ai-sdk/azure`, Responses API |
  | `openai` with `api: "CHAT_COMPLETIONS"` | `/openai/v1/chat/completions` | `@ai-sdk/azure` Chat Completions |
  | `anthropic` | `<resource origin>/anthropic/v1/messages` | `@ai-sdk/anthropic` |
  | `other` (DeepSeek, Llama, Grok…) | `/openai/v1/chat/completions` | Chat Completions |

- **Credentials**
  - `API_KEY`: `apiKey`, from Foundry portal → resource → Keys and Endpoint. It is sent as `api-key` (OpenAI
    surface) or `x-api-key` (Anthropic surface).
  - `ENTRA_ID`, service principal: `tenantId`, `clientId` and `clientSecret`.
  - `ENTRA_ID`, managed or workload identity: no credentials, or only `clientId` for a user-assigned identity. This
    goes through `DefaultAzureCredential`.
  - Entra scopes: `https://cognitiveservices.azure.com/.default` for the OpenAI surface and
    `https://ai.azure.com/.default` for Claude. Claude uses a bearer-injecting `fetch` because `@ai-sdk/anthropic`
    only takes a static token.
  - Assign the identity "Cognitive Services OpenAI User" and/or "Azure AI User" on the resource. **UNVERIFIED live:**
    which of the two roles is required for Claude on Foundry.

### OpenAI (`OPENAI`)

- **Settings:** `baseURL?`, `organization?`, `project?`, `storeResponses` (default `false`, so
  `store: false` is sent), `explicitCacheBreakpoints?`. When unset, breakpoints are chosen by model id: on for
  GPT-5.6 and later.
- **Credentials:** `apiKey`, from platform.openai.com → API keys. Use a project-scoped key.
- The provider uses the Responses API (`openai(model)`). The health probe uses `max_output_tokens: 16`, the API
  minimum.

### Anthropic (`ANTHROPIC`)

- **Settings:** `baseURL?`.
- **Credentials:** `apiKey`, from console.anthropic.com → API keys, sent as `x-api-key`.
- The default `healthModel` is `claude-haiku-4-5`.

### Sarvam (`SARVAM`)

- **Settings:** `baseURL` (default `https://api.sarvam.ai/v1`).
- **Credentials:** `apiKey`, the API subscription key from dashboard.sarvam.ai. It is sent both as
  `api-subscription-key` and as `Authorization: Bearer`.
- **Path:** `createOpenAICompatible` with `includeUsage: true`. `sarvam-ai-sdk` is not used, because it drops
  streamed usage.
- **Reasoning mapping**

  | OCSO `reasoning` | Sent to Sarvam |
  |---|---|
  | `none` | `reasoning_effort: null` (thinking off) |
  | `low` | `low` |
  | `medium` | field omitted (provider default) |
  | `high` | `high` |

  The health probe disables thinking.

### Dev scripted (`DEV_SCRIPTED`) — development only (ADR-015)

- **Registration:** `devOnly: true`, so registered only with `createDefaultRegistry({ enableDevProviders: true })`,
  and its usage is never priced. It is a custom
  `LanguageModelV4`, so it runs through exactly the same core path as the real providers.
- **Settings:** `latencyMs` (simulated TTFT, default 300), `chunkDelayMs` (default 25) and `simulateError`
  (`RATE_LIMITED` | `UNAVAILABLE`, for demoing retry and fallback).
- **Behavior**
  - "human" or "agent please" → a call to the tool whose name ends with `request_handoff`.
  - refund, reverse, balance or transaction(s) → a call to the tool whose name contains that word, with plausible
    arguments taken from the schema and the text (amounts, ids, account digits).
  - After tool results → a summary.
  - Anything else → a labelled echo.
- **Usage:** synthetic, with a simulated prefix cache. The first request with a given prefix writes the cache;
  repeats read it, so cache telemetry can be demoed.

## Prompt caching per provider

The compiler places up to three breakpoints: `AGENT_PREFIX`, `CONVERSATION_CONTEXT` and `HISTORY`. Markers go on
the system block or on the last part of the message. If more than four sites exist, the first three plus the last
are kept. With `request.cache.policy === 'OFF'`, no provider receives any cache directive. The contract tests assert
this for every provider.

| Provider / path | Directives sent (PREFIX) | Usage reported |
|---|---|---|
| Anthropic, Vertex-Claude, Foundry-Claude | `cache_control: {type:'ephemeral'[, ttl:'1h']}` at each breakpoint (≤ 4). `toolStreaming: false` keeps tool definitions identical between stream and generate calls | reads `cache_read_input_tokens`, writes `cache_creation_input_tokens`; input = input + read + write |
| Bedrock Converse (Claude, Nova) | `cachePoint {type:'default'}` blocks (a system cachePoint also covers tools); `ttl:'1h'` only on Claude 4.5+ | `cacheReadInputTokens`, `cacheWriteInputTokens`; input = input + read + write |
| Bedrock, other families | none | `null` / `null` |
| Vertex Gemini | none (implicit caching; `cachedContent` deliberately unused) | reads `cachedContentTokenCount`; writes `null` |
| OpenAI / Foundry-OpenAI before GPT-5.6 | `prompt_cache_key` = `request.cache.key`; `prompt_cache_retention:'24h'` when `ttl:'1h'` | reads `cached_tokens`; writes `null` |
| OpenAI / Foundry-OpenAI GPT-5.6+ | the above plus `prompt_cache_options {mode:'implicit'}` and part-level `prompt_cache_breakpoint`. Assistant output text has no breakpoint slot, so the implicit tail breakpoint covers it | reads and writes (`cache_write_tokens`) |
| Foundry `other` | none | reads only if `prompt_tokens_details.cached_tokens` is present, else `null` |
| Sarvam | none (`promptCaching: 'UNVERIFIED'`) | same as Foundry `other` |

## Tests

Run `npx vitest run packages/model-providers` from the repository root.

- **Contract suite:** `test/contract/provider-contract.ts` runs against eight provider paths through a fake
  `fetch` that returns recorded provider-format responses:
  - Anthropic SSE
  - Bedrock ConverseStream binary event-stream (CRC-valid frames)
  - Vertex Gemini SSE
  - Vertex Claude
  - Foundry Responses SSE
  - Foundry Claude
  - Foundry Chat Completions SSE
  - Sarvam Chat Completions SSE
- **What the suite checks**
  - cache directives on and off
  - sorted, schema-only tools
  - exact normalized usage
  - event order
  - TTFT and latency
  - 429/500/503/timeout/cancel mapping
  - no credential leakage (error bodies echo the keys)
  - health
- **Other suites:** the dev-scripted provider, the registry, error normalization, and prompt/tool translation.

## Needs live verification (credentials required)

The contract tests verify request and response shapes only. No live calls have been made.

- **Every provider:** real auth, real error bodies and status codes, streaming chunk boundaries, and cache hit and
  write behavior against live caches, including the minimum cacheable prefix per model.
- **Bedrock**
  - `IAM_ROLE` mode on ECS.
  - `ttl:'1h'` cachePoints on Claude 4.5+.
  - Nova cachePoint limits.
  - The adapter pins SigV4 in `ACCESS_KEYS`/`IAM_ROLE` modes, so an ambient `AWS_BEARER_TOKEN_BEDROCK` cannot
    override the configuration (tested). The same applies to `GOOGLE_VERTEX_API_KEY` for Vertex.
- **Vertex**
  - `APPLICATION_DEFAULT` mode.
  - Gemini implicit-cache minimums and whether caching still hits when tools are present (vercel/ai#11513).
  - Whether Vertex returns a request-id header. Today the request id comes from the body id.
- **Foundry**
  - Entra ID flows, both service principal and managed identity, and the required RBAC roles.
  - Whether Claude on Foundry accepts the SDK's `anthropic-beta` headers.
  - GPT-5.6 breakpoints on Foundry.
  - Cache reporting for `other` deployments.
  - Project-endpoint URLs.
- **OpenAI:** GPT-5.6 `prompt_cache_options` and breakpoint billing.
- **Sarvam**
  - Acceptance of `stream_options`.
  - `reasoning_effort: null`.
  - Whether it returns `cached_tokens`.
  - Tool-call streaming format.
  - Health-probe behavior with `max_tokens: 1`.
- **Known gaps**
  - OpenAI reasoning models run with `store: false`, so encrypted reasoning items are not carried across turns.
  - Explicit Gemini `cachedContent` is not implemented; this is by design (ADR-006).
  - Bedrock InvokeModel (`/anthropic`) and Mantle paths are not wired.
