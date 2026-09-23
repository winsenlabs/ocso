# Model Providers

## 1. Supported provider targets

OCSO must be able to integrate:
- AWS Bedrock
- Google Vertex AI
- Microsoft Foundry
- OpenAI API
- Anthropic API
- Sarvam API

Support is implemented through adapters, ideally reusing Vercel AI SDK provider packages or compatible provider interfaces where robust.

## 2. Logical model profiles

Virtual agents should reference logical profiles, not hard-coded provider model IDs.

Example:
```
support-primary
support-fast
sales-primary
summarizer
```

A profile may resolve to:
- provider
- model ID/deployment
- region
- temperature
- max output tokens
- reasoning settings
- timeout
- retry policy
- cache strategy
- fallbacks

## 3. Normalized interface

Conceptually:
```ts
interface ModelProviderAdapter {
  stream(request: OCSOModelRequest): Promise<OCSOModelStream>;
  generate(request: OCSOModelRequest): Promise<OCSOModelResult>;
  capabilities(): ModelCapabilities;
  health(): Promise<ProviderHealth>;
}
```

Normalized result should include:
- output/stream events
- finish reason
- provider/model identity
- provider request ID
- token usage
- cached token metrics when available
- latency and TTFT
- tool-call events
- normalized errors

## 4. Capability negotiation

Adapters declare support for:
- text
- image input
- audio input if applicable
- tool calling
- structured output
- reasoning controls
- prompt caching
- streaming
- provider-native conversation state if intentionally supported

Agent/runtime must fail clearly or choose an authorized compatible profile when required capabilities are absent.

## 5. Fallbacks

Fallback is policy, not magic.

A profile may define ordered fallback targets, but an organization may prohibit cross-provider or cross-region fallback.

Fallback must not silently violate:
- data residency
- provider allowlists
- capability requirements
- cost constraints

Every fallback is observable and auditable.

## 6. Secrets

Provider credentials must be stored in a secret store or encrypted secret mechanism. PostgreSQL stores references/configuration, not plaintext production secrets.

## 7. Latest-stack rule

Use the latest stable provider SDK/AI SDK versions compatible with the system at implementation time. Do not freeze documentation to stale package versions unless reproducibility requires it; lock actual dependencies in the package manager lockfile.

## Implementation notes (as built)

**Model discovery (ADR-027).** Every adapter has an optional `listModels()`, which returns
`ProviderModelInfo`: id, display name, created and owned-by when reported, kind
(`model` | `inference-profile` | `deployment`), lifecycle, and input kinds and limits **only when the
provider's listing documents them**. It uses the adapter's own credentials and injected `fetch`, a
15 s deadline, and the same error normalization as model calls; credential values are scrubbed.

| Kind | Listing | Notes |
|---|---|---|
| OPENAI | `GET {baseURL}/models` | Chat models only. Documented filter `OPENAI_NON_CHAT`: embeddings, audio/realtime, image/video generation, moderation, legacy completions, search-preview and computer-use are dropped. |
| ANTHROPIC | `GET {baseURL}/models?limit=1000`, then `after_id` pages | `capabilities.image_input` / `pdf_input` → input kinds; `max_input_tokens` / `max_tokens` → limits. |
| BEDROCK | `GET bedrock.<region>.amazonaws.com/foundation-models?byOutputModality=TEXT` + `/inference-profiles` (paged) | SigV4 (aws4fetch) or bearer API key. On-demand text models, plus system-defined (id) and application (ARN) inference profiles of text models. |
| VERTEX | `GET <host>/v1/publishers/{google,anthropic}/models` (paged) | Service-account or ADC token, `x-goog-user-project`. `gemini-*` chat models and `claude-*`; dated Claude versions become `@YYYYMMDD`. |
| FOUNDRY | configured `settings.deployments` | An inference key cannot list deployments (ARM). The declared `model` is the catalog `baseModel`. |
| SARVAM | `GET {baseURL}/models` (OpenAI-compatible) | 404 → `model_listing_unsupported` → catalog entries instead. |
| DEV_SCRIPTED | `scripted-1`, `scripted-2`, health model | — |

`GET /v1/model-providers/:id/models` (providers.read; `?refresh=true` needs providers.manage) goes
through `CachedProviderAdapterSource`. It caches per provider configuration (keyed by `updated_at`)
for 10 minutes. It merges catalog metadata (context window, input kinds, tool calling) and returns,
per model, `catalogPrice` (what the catalog offers) and `configuredPrice` (the `model_pricing` row
that will cost it). A listing failure is a typed `error` in a 200 body. The web picker shows it and
still accepts free text.

**Model catalog and prices (ADR-027).**

- **Sources.** Metadata and prices come from models.dev (primary) and LiteLLM (fallback),
  normalized to USD per 1M tokens with long-context tiers (`packages/model-providers/src/catalog`).
  There is no price table in code.
- **Snapshots.** The latest validated snapshot per source lives in `model_catalog_snapshots`. The
  vendored snapshot in `@ocso/model-providers/catalog/` is the offline fallback.
- **Refresh.** The worker leader checks hourly and downloads when a source is 24 h old (1 h after a
  failure). Tech admins can run `POST /v1/model-catalog/refresh`. Downloads go through the SSRF guard
  plus a host allowlist; `GET /v1/model-catalog` shows the status.
- **`model_pricing` stays the costing source of truth.** It has `origin` (`catalog` | `manual`),
  `catalog_source`, `catalog_provider`, `catalog_model_id`, `catalog_fetched_at` and `tiers`.
  - **Profile save.** Saving a profile adds catalog rows for targets without a price and reports
    `prices` per target (`priced` | `added` | `missing`).
  - **Refresh.** A refresh moves catalog rows to the current catalog price (audited, effective now).
  - **Admin edit.** An edit makes a row `manual`; refreshes never touch manual rows.
  - **Matching.** Catalog rows match exact ids only; manual rows keep the prefix rule.
  - **Missing prices.** `GET /v1/model-pricing/missing` lists models in use without a price.
    `POST /v1/model-pricing/from-catalog` adds the catalog's price for one model.
- **Costing.** The usage recorder, telemetry and the budget alert share `selectPrice` and
  `usageCostMicros` (tiers by request input size). Usage without a price is counted as
  `unpricedRequests` and shown as "no price", never as zero.

The catalog-key mapping per kind, the official-price cross-check and the known approximations are in
PM/research/09-models-and-prices.md.

