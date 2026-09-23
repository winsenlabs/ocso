# 09: Model discovery, model catalogs and prices

Researched 2026-09-22. Implemented in `packages/model-providers/src/{discovery,catalog,pricing}`,
`packages/application/src/models/{model-list-service,pricing-missing}.ts` and
`packages/application/src/models/catalog/*`, and `packages/application/src/alerts/evaluators/spend-budget-above.ts`.
The decision is recorded as ADR-027.

Tags: **VERIFIED(docs)** means it comes from the vendor's own documentation fetched on 2026-09-22.
**VERIFIED(run)** means our unit or integration tests exercise the documented shape against a faked
endpoint. **VERIFIED(live)** means we called the real endpoint. **UNVERIFIED** means it has not been
checked against a live account.

## TL;DR

- **Model lists come from the providers.** Every adapter gets an optional `listModels()`. OpenAI and
  Anthropic call `GET /v1/models`. Bedrock calls ListFoundationModels plus ListInferenceProfiles.
  Vertex lists Model Garden publisher models for `google` and `anthropic`. Foundry returns the
  deployments configured in its settings. Sarvam calls its OpenAI-compatible `GET /v1/models` and falls
  back to the catalog if that returns 404.
- **No provider listing returns prices.** Anthropic's listing is the only one that returns
  capabilities and limits. Everything else (context window, input kinds, tool calling, prices) comes
  from **open-source catalogs**:
  - **models.dev** is the primary source.
  - **LiteLLM's** `model_prices_and_context_window.json` fills in models that models.dev lacks.
  - Both are MIT licensed.
  - OCSO keeps **no hand-maintained price table in code**.
- **`model_pricing` stays the source of truth for costs.**
  - Saving a profile pre-fills a row from the catalog (`origin: 'catalog'`, with source and fetch date).
  - A catalog refresh moves catalog rows to the new price (audited as a system change).
  - An admin edit makes a row `manual`, and refreshes never touch manual rows.
  - Usage without a price shows **"no price"**, never zero.
- **Cross-check:** for every OpenAI and Anthropic text model listed below, the models.dev entry matched
  the vendor's own pricing page exactly on 2026-09-22 (input, cached input / cache read, cache write,
  output).
- **Not used as data sources:** the Vercel AI Gateway model list and OpenRouter. Both are hosted
  resellers, and the prices they publish are their own, not the underlying provider's.

## 1. OpenAI `GET /v1/models` — VERIFIED(docs), VERIFIED(run)

Source: <https://developers.openai.com/api/reference/resources/models/methods/list> (checked 2026-09-22).

- **Auth:** `Authorization: Bearer <key>`, plus the optional `OpenAI-Organization` and
  `OpenAI-Project` headers. OCSO sends both headers when they are configured.
- **Response:** `{ object: "list", data: [{ id, object: "model", created (unix seconds), owned_by,
  shutdown_date|null }] }`.
- **No pagination.** No prices, no capabilities and no limits are returned.
- **The listing mixes every model family.** OCSO keeps chat models only, using a documented rule
  (`OPENAI_NON_CHAT` in `discovery/openai.ts`). An id is dropped when it contains `embedding`,
  `whisper`, `transcribe`, `tts`, `audio`, `realtime`, `dall-e`, `gpt-image`, `chatgpt-image`,
  `image`, `sora`, `moderation`, `-instruct`, `search-preview` or `computer-use`, or when it starts with
  `davinci` or `babbage`. Fine-tunes (`ft:…`) and codex models stay.

## 2. Anthropic `GET /v1/models` — VERIFIED(docs), VERIFIED(run)

Source: <https://platform.claude.com/docs/en/api/models/list> (checked 2026-09-22).

- **Headers:** `x-api-key` and `anthropic-version: 2023-06-01`.
- **Pagination:** `limit` (default 20, range 1–1000), `after_id` and `before_id`. The response has
  `data`, `first_id`, `last_id` and `has_more`, newest first. OCSO sends `limit=1000` and follows
  `after_id` for at most 20 pages.
- **Item fields:** `id`, `type: "model"`, `display_name` and `created_at` (RFC 3339). The item also
  has `max_input_tokens`, `max_tokens` and a `capabilities` object (`image_input`, `pdf_input`,
  `structured_outputs`, `thinking`, `effort`, `batch`, …, each `{ supported }`).
- **What OCSO maps:** `image_input` and `pdf_input` become input kinds. `max_input_tokens` and
  `max_tokens` become limits when they are greater than 0; the docs example shows `0` placeholders.
  Nothing else is inferred.

## 3. AWS Bedrock control plane — VERIFIED(docs), VERIFIED(run), UNVERIFIED(live)

Sources: <https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html> and
<https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListInferenceProfiles.html>, both checked
2026-09-22.

### Requests

- `GET https://bedrock.<region>.amazonaws.com/foundation-models?byOutputModality=TEXT`. Filters:
  `byProvider`, `byCustomizationType`, `byInferenceType` (`ON_DEMAND`|`PROVISIONED`) and
  `byOutputModality` (`TEXT`|`IMAGE`|`EMBEDDING`). No pagination.
- `GET https://bedrock.<region>.amazonaws.com/inference-profiles?maxResults=1000&nextToken=…`, with
  an optional `type=SYSTEM_DEFINED|APPLICATION`.

### Response fields

- **Foundation models:** `modelSummaries[]` with `modelId`, `modelName`, `providerName`,
  `inputModalities`, `outputModalities`, `inferenceTypesSupported` (`ON_DEMAND`, `PROVISIONED`,
  `INFERENCE_PROFILE`), `modelLifecycle.status` (`ACTIVE`|`LEGACY`) and
  `responseStreamingSupported`.
- **Inference profiles:** `inferenceProfileSummaries[]` with `inferenceProfileId`,
  `inferenceProfileArn`, `inferenceProfileName`, `models[].modelArn`, `status` and `type`.

### Auth

- OCSO signs with SigV4 (service `bedrock`) using aws4fetch. The AI SDK Bedrock provider uses the
  same signer, and aws4fetch was already in the lockfile. `@aws-sdk/client-bedrock` was not added.
- In API-key mode, the key is sent as `Authorization: Bearer`. AWS documents that Bedrock API keys
  cover Bedrock and Bedrock Runtime actions: <https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html>.
- The region comes from settings first, then from the provider record. The settings `baseURL` is the
  runtime endpoint, so it is not used for the control plane.

### Rules

- A foundation model is listed when it outputs TEXT, accepts TEXT, is not an embedding model and
  supports `ON_DEMAND`.
- Models that only support `INFERENCE_PROFILE` (current Claude models) appear as their profiles:
  - System-defined profiles are invoked by id (`us.anthropic.claude-…`).
  - Application profiles are invoked by ARN.
  - A profile is listed only when its underlying model is a listed text model. It inherits that
    model's input kinds.

## 4. Google Vertex AI Model Garden — VERIFIED(docs), VERIFIED(run), UNVERIFIED(live)

Sources: the REST reference `publishers.models.list` (v1beta1:
<https://docs.cloud.google.com/vertex-ai/docs/reference/rest/v1beta1/publishers.models/list>), and
"Use models in Model Garden"
(<https://docs.cloud.google.com/vertex-ai/generative-ai/docs/model-garden/use-models>), which shows
`GET https://us-central1-aiplatform.googleapis.com/v1/publishers/*/models` with
`x-goog-user-project`. Both checked 2026-09-22.

### Request and response

- OCSO calls `GET https://<host>/v1/publishers/{google|anthropic}/models?pageSize=100&pageToken=…`.
  - The host is `aiplatform.googleapis.com` for `global` and multi-regions, otherwise
    `<location>-aiplatform.googleapis.com`.
  - The OAuth bearer comes from the configured service account. OCSO signs the JWT and exchanges it
    itself; in `APPLICATION_DEFAULT` mode it uses google-auth-library ADC.
  - `x-goog-user-project` is set to the project.
- The response has `publisherModels[]` with `name` (`publishers/<p>/models/<id>`), `versionId`,
  `launchStage`, `versionState`, `openSourceCategory`, `supportedActions` and so on, plus
  `nextPageToken`. It carries no modalities and no limits.

### Rules

- Only publishers `google` (Gemini) and `anthropic` (Claude) are listed, because the adapter routes
  only those two.
- Google ids must be `gemini-*` and must not be embedding, TTS, image, live or native-audio variants.
- Claude ids must be `claude-*`. An 8-digit `versionId` is appended as `@YYYYMMDD`, because Claude
  models before 4.6 are called as `claude-…@date` on Vertex.
- `launchStage: DEPRECATED` becomes `lifecycle: DEPRECATED`.

**Caveat (UNVERIFIED).** The Model Garden listing is the catalog of publisher models. It does not say
whether a model is enabled or has quota in the project. If Google changes what `versionId` holds for
Claude, the id mapping in `vertexModelId()` needs a look. A live check with a real project is still
owed.

## 5. Foundry and Sarvam

- **Microsoft Foundry:**
  - Listing deployments needs Azure control-plane (ARM) access, and an inference API key does not
    grant it. OCSO therefore lists the deployments configured in the provider settings. The declared
    `model` is used as `baseModel` for catalog lookups.
  - Anthropic documents that Foundry deployments default to the model id as their name:
    <https://platform.claude.com/docs/en/about-claude/models/overview>.
- **Sarvam:**
  - Its docs (<https://docs.sarvam.ai/api-reference-docs/getting-started/models>) list `sarvam-105b`
    and `sarvam-105b-conversations`, with `sarvam-30b` and `sarvam-m` deprecated. They document no
    listing endpoint and no per-token prices.
  - The OpenAI-compatible `GET https://api.sarvam.ai/v1/models` does answer. It returned
    `sarvam-105b` and `sarvam-105b-conversations` unauthenticated on 2026-09-22 (VERIFIED(live)).
  - OCSO calls it with the key. On 404 it falls back to the catalog's `sarvam` entries.
  - Neither catalog prices Sarvam, so Sarvam usage shows "no price" until an admin enters one.

## 6. Open-source catalogs — VERIFIED(live)

| | models.dev (primary) | LiteLLM (fallback) |
|---|---|---|
| URL | `https://models.dev/api.json` | `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` |
| License | MIT (github.com/sst/models.dev) | MIT (github.com/BerriAI/litellm) |
| Size (2026-09-22) | 4.8 MB, 223 providers | 2.9 MB, 4,500 entries |
| Shape | `{ [provider]: { models: { [id]: { name, cost{input,output,cache_read,cache_write,tiers[{…,tier{type:'context',size}}],context_over_200k}, limit{context,output}, modalities{input}, tool_call, reasoning, status } } } }` | `{ [key]: { litellm_provider, mode, input_cost_per_token, output_cost_per_token, cache_read_input_token_cost, cache_creation_input_token_cost, *_above_<N>k_tokens, max_input_tokens, max_output_tokens, supports_* } }` |
| Units | USD per 1M tokens | USD per token (OCSO × 1e6, rounded to micro-dollars) |
| Keys used | `openai`, `anthropic`, `amazon-bedrock`, `google-vertex`, `google-vertex-anthropic`, `azure`, `sarvam` | `litellm_provider` ∈ `openai`, `anthropic`, `bedrock`, `bedrock_converse`, `vertex_ai-language-models`, `vertex_ai-anthropic_models`, `azure`, `azure_ai`; `mode` ∈ `chat`, `responses` |

Normalized snapshot (2026-09-22): models.dev had 384 models for these providers (377 priced), and
LiteLLM had 973 (937 priced). The vendored copy is `packages/model-providers/catalog/vendored-snapshot.json`
(298 KB). Regenerate it with `node scripts/refresh-model-catalog.mjs` after building
`@ocso/model-providers`.

### Mapping: OCSO kind + model id → catalog key

Implemented in `catalog/mapping.ts`. Tests in `test/catalog/catalog.test.ts`.

| Kind | models.dev | LiteLLM |
|---|---|---|
| OPENAI | `openai/<id>` | `openai`: `<id>` |
| ANTHROPIC | `anthropic/<id>` | `anthropic`: `<id>` |
| BEDROCK | `amazon-bedrock/<id>` exactly. Region prefixes (`us.`, `eu.`, `global.`, `jp.`, `au.`, `apac.`) are distinct, differently priced entries and are **never stripped**. | `bedrock_converse`, `bedrock`: `<id>` |
| VERTEX Claude | `google-vertex-anthropic`, then `google-vertex`: dateless id → `<id>@default`; dated `<id>@YYYYMMDD` unchanged | `vertex_ai-anthropic_models`: `vertex_ai/<id>` |
| VERTEX Gemini | `google-vertex/<id>` | `vertex_ai-language-models`: `<id>`, `vertex_ai/<id>` |
| FOUNDRY | `azure/<declared model or deployment name>` | `azure`: `azure/<…>`; `azure_ai`: `azure_ai/<…>` |
| SARVAM | `sarvam/<id>` | — |
| DEV_SCRIPTED | never priced | — |

Rules:

- **Exact keys only. No family guessing.** A dated snapshot is priced only when the catalog lists that
  exact dated id. For example, models.dev lists `claude-haiku-4-5-20251001`, which Anthropic documents
  as the snapshot behind the alias `claude-haiku-4-5`. LiteLLM lists `gpt-5.5-2026-04-23`. An id that
  neither catalog lists (say `gpt-4o-mini-2024-07-18`) gets **no price**.
- **Bedrock application-profile ARNs are never priced.** They are opaque.
- **Catalog price rows match their exact model id only** (`selectPrice`). A catalog row for `gpt-5.5`
  must never cost `gpt-5.5-pro`. Manual rows keep the legacy prefix rule (`claude-sonnet-4-*`, with
  the trailing `*` optional).
- **Precedence:** an exact match beats a prefix, a longer prefix beats a shorter one, manual beats
  catalog, then the latest effective row wins. Rows with a future `effectiveFrom` are ignored (the
  usage recorder previously used them).

## 7. Official prices, cross-checked against models.dev (USD per 1M tokens, standard tier, checked 2026-09-22)

### Anthropic

Source: <https://platform.claude.com/docs/en/about-claude/pricing>. API ids come from
<https://platform.claude.com/docs/en/about-claude/models/overview> and
<https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions>.

| Model (API id) | Input | 5m cache write | 1h cache write | Cache read | Output | models.dev |
|---|---|---|---|---|---|---|
| Claude Fable 5.1 (`claude-fable-5-1`) | 10 | 12.50 | 20 | 0.25 | 50 | match |
| Claude Fable 5 (`claude-fable-5`) | 10 | 12.50 | 20 | 1 | 50 | match |
| Claude Opus 5 (`claude-opus-5`) | 5 | 6.25 | 10 | 0.50 | 25 | match |
| Claude Opus 4.8 / 4.7 / 4.6 (`claude-opus-4-8`, `-4-7`, `-4-6`) | 5 | 6.25 | 10 | 0.50 | 25 | match |
| Claude Opus 4.5 (`claude-opus-4-5` → `claude-opus-4-5-20251101`) | 5 | 6.25 | 10 | 0.50 | 25 | match (both ids) |
| Claude Sonnet 5 (`claude-sonnet-5`) | 2 | 2.50 | 4 | 0.20 | 10 | match |
| Claude Sonnet 4.6 (`claude-sonnet-4-6`) | 3 | 3.75 | 6 | 0.30 | 15 | match |
| Claude Sonnet 4.5 (`claude-sonnet-4-5` → `claude-sonnet-4-5-20250929`) | 3 | 3.75 | 6 | 0.30 | 15 | match (both ids) |
| Claude Haiku 4.5 (`claude-haiku-4-5` → `claude-haiku-4-5-20251001`) | 1 | 1.25 | 2 | 0.10 | 5 | match (both ids) |

Notes:

- **Sonnet 5 pricing is now standard.** The $2 / $10 launch pricing became the standard price; the
  increase scheduled for 2026-09-01 did not happen.
- **Newer tokenizer.** Claude 4.7 and later use a tokenizer that produces about 30% more tokens for
  the same text.
- **US-only inference costs more.** `inference_geo: "us"` is ×1.1 on Claude 4.6 and later. Bedrock
  and Vertex regional endpoints are +10%, and models.dev prices the `us.`/`eu.`/… Bedrock profiles
  accordingly.
- **1M context at standard price** for Claude 4.6 and later.
- **1-hour cache writes.** models.dev and `model_pricing` carry one cache-write price, the 5-minute
  rate. Profiles with `cacheTtl: 1h` therefore under-cost cache writes by 1.6× on Anthropic models.
  This is a known approximation; LiteLLM has `cache_creation_input_token_cost_above_1hr`, but OCSO
  does not use it yet.

### OpenAI

Source: <https://developers.openai.com/api/docs/pricing>, standard tier, short context. The page data
was read programmatically.

| Model | Input | Cached input | Cache write | Output | models.dev |
|---|---|---|---|---|---|
| gpt-6-astra | 10.00 | 1.00 | 12.50 | 50.00 | match |
| gpt-5.6-sol (promotional through at least 2026-11-21) | 4.00 | 0.40 | 5.00 | 20.00 | match |
| gpt-5.6-terra | 2.00 | 0.20 | 2.50 | 12.00 | match |
| gpt-5.6-luna | 0.20 | 0.02 | 0.25 | 1.20 | match |
| gpt-5.5 (< 272K) | 5.00 | 0.50 | — | 30.00 | match |
| gpt-5.4 (< 272K) | 2.50 | 0.25 | — | 15.00 | match |
| gpt-5.4-mini | 0.75 | 0.075 | — | 4.50 | match |
| gpt-5.4-nano | 0.20 | 0.02 | — | 1.25 | match |
| gpt-5.2 | 1.75 | 0.175 | — | 14.00 | match |
| gpt-5.1 / gpt-5 | 1.25 | 0.125 | — | 10.00 | match |
| gpt-5-mini | 0.25 | 0.025 | — | 2.00 | match |
| gpt-5-nano | 0.05 | 0.005 | — | 0.40 | match |
| gpt-4.1 | 2.00 | 0.50 | — | 8.00 | match |
| gpt-4.1-mini | 0.40 | 0.10 | — | 1.60 | match |
| gpt-4.1-nano | 0.10 | 0.025 | — | 0.40 | match |
| gpt-4o | 2.50 | 1.25 | — | 10.00 | match |
| gpt-4o-mini | 0.15 | 0.075 | — | 0.60 | match |
| o3 | 2.00 | 0.50 | — | 8.00 | match |
| o4-mini | 1.10 | 0.275 | — | 4.40 | match |

Notes:

- **Long context.** Long-context rates apply above 272K input tokens:
  - gpt-6-astra: 20 / 2 / 25 / 75
  - gpt-5.6-sol: 8 / 0.8 / 10 / 30
  - gpt-5.6-terra: 4 / 0.4 / 5 / 18
  - gpt-5.6-luna: 0.4 / 0.04 / 0.5 / 1.8
  - gpt-5.5: 10 / 1 / — / 45
  - gpt-5.4: 5 / 0.5 / — / 22.5

  models.dev carries these as `tiers[{tier:{type:'context',size:272000}}]`. OCSO stores them in
  `model_pricing.tiers` and applies the highest tier whose threshold the request's input exceeded.
- **Other surcharges.** Regional processing (data residency) adds 10% for models released on or after
  2026-03-05. Batch is 50% off. "Priority" was renamed Fast mode on 2026-07-30 and is ×2 on the newest
  models. OCSO prices the standard tier only.

## 8. What OCSO does not do (yet)

- **Tier, batch, fast mode, data residency and 1-hour cache writes are not modeled per request.** A
  deployment that uses them should enter a manual price.
- **The budget alert re-prices older usage approximately.** It prices "recorded without a cost"
  usage at the per-model *average* input size, so long-context tiers are approximate for that usage
  (method text on the evaluator).
- **Prices are USD only.** Recorded costs in other currencies are excluded from the USD budget and
  reported in the alert body.
- **Vertex and Bedrock listings have not been checked against live accounts.** See §3 and §4.
