# 01: Vercel AI SDK v7 and the six model providers

Researched 2026-09-22. **Method:** I installed these packages into `/private/tmp/claude-501/research-ai`:

- `ai@7.0.109`, `@ai-sdk/provider@4.0.17`, `@ai-sdk/provider-utils@5.0.45`
- `@ai-sdk/{anthropic@4.0.59, amazon-bedrock@5.0.90, google-vertex@5.0.89, azure@4.0.76, openai@4.0.72, openai-compatible@3.0.53, react@4.0.112}`
- `sarvam-ai-sdk@0.4.4`, `sarvamai@1.1.10`, `fastify@5.12.5`

I read the `.d.ts` files, the docs bundled in each package (`node_modules/*/docs/*.mdx`) and the compiled JS where it mattered.

I then ran scripts with Node 26 and `tsc` in strict mode. The scripts (`v1-core.ts` through `v7-custom.ts`) are in that directory. The provider checks call each real provider package through a fake `fetch`: the script captures the real request body and feeds back a canned provider response. That checks request shapes and usage mapping without network calls.

Provider facts come from AWS, Microsoft, Google and Sarvam docs, fetched today. The tags mean:
- **VERIFIED(run):** a script confirmed it.
- **VERIFIED(types):** confirmed in the `.d.ts` files or the shipped JS.
- **UNVERIFIED:** not confirmed either way.

## TL;DR

- **The v7 surface changed a lot.** The system prompt option is now `instructions` (a string, a `SystemModelMessage`, or an array of them). `stopWhen: isStepCount(n)` replaces `stepCountIs`. `result.usage` is now the sum over **all steps**, so `totalUsage` is deprecated and per-step usage lives on `finalStep`/`steps`. `fullStream` is now `stream`. Response helpers are standalone functions: `toUIMessageStream` and `pipeUIMessageStreamToResponse`. The packages are **ESM-only** and need **Node ≥22**. NestJS 12.0.4 also ships as ESM, so the two fit together.
- Tools still use `inputSchema`, via `tool({ description, inputSchema, execute? })` or `jsonSchema()` for raw MCP JSON Schema. A tool **without `execute`** stops the loop with `finishReason: 'tool-calls'`. We then authorise and execute it ourselves and push a `role:'tool'` result. VERIFIED(run).
- **Cache usage is normalised in core.** Every provider maps to `usage.inputTokenDetails.{cacheReadTokens, cacheWriteTokens, noCacheTokens}`. The Anthropic metadata field `cacheCreationInputTokens` was removed. TTFT is built in as `finish-step.performance.timeToFirstOutputMs`.
- There is **no official `@ai-sdk/*` package for Microsoft Foundry or Sarvam** (the npm registry returns 404). For Foundry:
  - OpenAI-family deployments use `@ai-sdk/azure` with the Foundry `/openai/v1` baseURL.
  - Claude on Foundry uses `@ai-sdk/anthropic` with baseURL `https://<res>.services.ai.azure.com/anthropic/v1`.
- For Sarvam, use `createOpenAICompatible`.
  - Sarvam's own `sarvam-ai-sdk` (github.com/sarvamai) **drops streamed usage** when the final chunk carries OpenAI-style top-level `usage`, as Sarvam's docs describe. It also never reports cached tokens.

## 1. Packaging and runtime

- **Versions:** `ai` 7.0.0 went GA on 2026-06-25 and `latest` is 7.0.109. There is no `ai@8` on npm. The dist-tags `ai-v6` (6.0.287) and `ai-v5` (5.0.262) still exist.
- **Runtime:** all packages are `"type":"module"`, ESM-only, with `engines.node >=22`. The migration guide recommends Node 24 LTS for production.
- **Peer dependency:** `zod ^3.25.76 || ^4.1.8`.
- **Gotcha:** `LanguageModel = GlobalProviderModelId | LanguageModelV4 | V3 | V2`, and a **string model id resolves to the Vercel AI Gateway** by default. Our adapters must always pass provider model *instances*. VERIFIED(types)
- **Telemetry:**
  - OpenTelemetry moved to `@ai-sdk/otel` (1.0.109), registered with `registerTelemetry(new OpenTelemetry())`.
  - Once an integration is registered, telemetry is **on by default**. Opt out per call with `telemetry: { isEnabled: false }`.
  - To silence warning logs, set `globalThis.AI_SDK_LOG_WARNINGS = false`.

## 2. Core API: `streamText` / `generateText`

Both functions take `LanguageModelCallOptions & RequestOptions & Prompt & { model, tools, toolChoice, stopWhen, providerOptions, activeTools, toolOrder, prepareStep, toolApproval, onStepEnd, onEnd, onChunk, onError, onAbort, … }`. VERIFIED(run+types):

```ts
import { streamText, tool, jsonSchema, isStepCount, type ModelMessage } from 'ai';
const result = streamText({
  model,                                   // provider instance, never a string (-> Gateway)
  instructions: [                          // string | SystemModelMessage | SystemModelMessage[]
    { role: 'system', content: STATIC_POLICY,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } }, bedrock: { cachePoint: { type: 'default' } } } },
    { role: 'system', content: perTenantBits },
  ],
  messages,                                // ModelMessage[]; a role:'system' entry THROWS (AI_InvalidPromptError) unless allowSystemInMessages:true
  tools, toolOrder: [], activeTools: ['lookupOrder'], toolChoice: 'auto',
  stopWhen: isStepCount(1),                // default isStepCount(1); also hasToolCall('x'), isLoopFinished(), custom StopCondition
  maxOutputTokens: 1024, temperature: 0.2, topP, topK, stopSequences, seed, presencePenalty, frequencyPenalty,
  reasoning: 'low',                        // 'provider-default'|'none'|'minimal'|'low'|'medium'|'high'|'xhigh'
  maxRetries: 2,                           // default 2; pre-stream only
  streamRetries: 0,                        // mid-stream provider-error retries (off when omitted)
  abortSignal: ac.signal,
  timeout: { totalMs: 60_000, stepMs, firstChunkMs: 10_000, chunkMs: 15_000, toolMs, tools: { lookupOrderMs: 5_000 } }, // or a number
  headers: { 'x-ocso-trace': traceId },
  providerOptions: { openai: { promptCacheKey: 'tenant-42:agent-7' } },
  include: { requestBody: false },         // v7 default: request bodies NOT kept in step results
});
```

- **Messages (`@ai-sdk/provider-utils`):** `ModelMessage = SystemModelMessage | UserModelMessage | AssistantModelMessage | ToolModelMessage`. Every message **and every part** accepts `providerOptions`.
  - User content: `string | (TextPart | FilePart | ImagePart(deprecated))[]`.
  - Assistant content adds `reasoning`, `reasoning-file`, `tool-call`, `tool-result`, `tool-approval-request` and `custom`.
  - Tool content: `tool-result | tool-approval-response`.
- **Files, including images, audio and PDF:** `{ type: 'file', data, mediaType: 'image/png' | 'image' | 'application/pdf' | 'audio/wav', filename? }`.
  - `data` can be a Buffer, Uint8Array, base64 string, `URL`, a `{ type: 'data' | 'url' | 'reference' | 'text' }` tagged union, or a `ProviderReference` map from `uploadFile`.
  - `{ type: 'image', image }` is deprecated in favour of a `file` part with an `image/*` media type.
- **Tools:**
  - The schema field is `inputSchema` (`parameters` was v4). The full options are `tool({ description (string | (ctx) => string), inputSchema, execute?, outputSchema?, strict?, inputExamples?, providerOptions?, contextSchema?, toModelOutput?, metadata?, deferLoading? })`.
  - The name comes from the key in the `tools` object; the `name` property was removed in v6.
  - Raw JSON Schema: `jsonSchema<T>(schema, { validate? })`. `dynamicTool({ description, inputSchema: jsonSchema(s) })` works for runtime MCP tools, with or without execute (both compile).
  - The MCP client is `createMCPClient` from **`@ai-sdk/mcp`**. HTTP redirects now default to `'error'`.
- **Tools without `execute`** (our authorisation-then-execute path). VERIFIED(run): the model emitted text plus one tool call with `stopWhen: isStepCount(5)`, and the loop still stopped after one step.

  ```ts
  const calls = await result.toolCalls;          // [{type:'tool-call', toolCallId, toolName, input:{orderId:'A1'} /* parsed */, dynamic?}]
  messages.push(...(await result.responseMessages)); // assistant msg: [text, tool-call]
  messages.push({ role: 'tool', content: calls.map(c => ({ type: 'tool-result', toolCallId: c.toolCallId, toolName: c.toolName,
    output: { type: 'json', value: out } /* or {type:'text'|'error-text'|'error-json'|'execution-denied', …} or {type:'content', value:[text|file]} */ })) });
  // call streamText again with the same instructions/tools -> model continues (verified; prompt roles system,user,assistant,tool)
  ```

  Built-in alternative: `toolApproval: { refund: 'user-approval' }` emits `tool-approval-request` parts. The caller answers with `{ role:'tool', content:[{ type:'tool-approval-response', approvalId, approved }] }`, and `experimental_toolApprovalSecret` HMAC-signs the approvals.
  - **Recommendation:** keep execution out of the SDK entirely. Use no-`execute` tools and let our `ToolExecutor` own authorisation, idempotency and audit.
- **Deprecated but still working in v7:** `system`, `onFinish` (now `onEnd`), `onStepFinish` (now `onStepEnd`), `experimental_telemetry` (now `telemetry`), `fullStream` (now `stream`), `totalUsage` (now `usage`), and `needsApproval` (now `toolApproval`).
- **Context:** `experimental_context` is replaced by tool-scoped `context`, supplied via `toolsContext[toolName]` and typed by `contextSchema`, plus a shared `runtimeContext`.

## 3. Results, usage, finish reasons, stream parts and TTFT

The usage shape (`LanguageModelUsage`, VERIFIED(types+run)):

```ts
{ inputTokens, inputTokenDetails: { noCacheTokens, cacheReadTokens, cacheWriteTokens },
  outputTokens, outputTokenDetails: { textTokens, reasoningTokens }, totalTokens, raw?: JSONObject }  // all number|undefined
```

`cachedInputTokens` and `reasoningTokens` were removed at the top level in v7.
- `result.usage` is the sum over all steps; `result.finalStep.usage` is the last step only; `result.steps[i].usage` is per step.
- In a stream, `finish-step.usage` is per step and **`finish.totalUsage`** is the total. The stream part still uses the name `totalUsage`. VERIFIED(run)

**`FinishReason`** is `'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'`. The provider's own string is in `rawFinishReason`: for example `tool_use`/`end_turn` on Anthropic, `STOP` on Gemini, and `undefined` on the OpenAI Responses API. `'unknown'` was merged into `'other'` in v6.

**IDs:** `finalStep.response.{id, modelId, timestamp, headers}`. The `finish-step` part carries the same object, minus the messages. VERIFIED(run) with fake responses:

| Provider | `response.id` | Useful request-id header |
|---|---|---|
| Anthropic / Vertex-Claude / Bedrock-invoke | `msg_…` | `request-id` (Anthropic) |
| Bedrock Converse | **the `x-amzn-requestid` header value** | same |
| OpenAI / Azure | `resp_…` (Responses API) / `chatcmpl-…` (Chat Completions) | `x-request-id`, and `apim-request-id` (Azure) |
| Vertex Gemini | body `responseId` | — |
| Sarvam | body `id` | — |

**`TextStreamPart` types**, which in v7 `onChunk` now receives in full:
- Lifecycle: `start`, `start-step`, `finish-step`, `finish`, `abort`, `error`, `raw`.
- Text: `text-start`, `text-delta` (`.text`), `text-end`.
- Reasoning: `reasoning-start`, `reasoning-delta` (`.text`), `reasoning-end`.
- Tool input: `tool-input-start`, `tool-input-delta` (`.delta`), `tool-input-end`.
- Tool calls and results: `tool-call`, `tool-result`, `tool-error`, `tool-output-denied`, `tool-approval-request`, `tool-approval-response`.
- Other: `source`, `file`, `reasoning-file`, `custom`.

Docs gotcha: the reasoning docs example uses `part.type === 'reasoning'` and `textDelta`, but the types say `reasoning-delta` and `.text`.

- **Errors in streams:** errors arrive as `{ type: 'error' }` parts and in `onError`; they are not thrown. An abort emits `{ type: 'abort' }` and calls `onAbort`.
- **TTFT:** `finish-step.performance` (and `StepResult.performance`) carries these fields. Most are streaming-only:
  - `timeToFirstOutputMs`: time to the first text, reasoning, tool-input or file chunk.
  - `responseTimeMs`, `stepTimeMs`, `toolExecutionMs`.
  - `outputTokensPerSecond`, `inputTokensPerSecond`.
  - `timeBetweenOutputChunksMs` with `{ min, p10, median, avg, p90, max }`.

  VERIFIED(run): with a 30 ms mock delay the built-in value was 46 ms and my hand-measured first `text-delta` was 48 ms. If we want **time to first visible text** specifically, measure it ourselves at the first `text-delta`.

## 4. Prompt-cache matrix (all six providers)

**Placement (VERIFIED(run)):** `providerOptions` is accepted on every `ModelMessage`, on every content part, on each `SystemModelMessage` inside `instructions: [...]`, on each `tool({ providerOptions })`, and at request level. Each provider reads only its own key, so one message object can carry markers for every provider at once.

| Provider (AI SDK path) | (a) Mode | (b) Knob → where it lands (verified request body) | (c) Minimum prefix / TTL |
|---|---|---|---|
| **Anthropic API** `@ai-sdk/anthropic` | Explicit breakpoints, plus automatic top-level | `anthropic.cacheControl: {type:'ephemeral', ttl?:'5m'\|'1h'}`. On a system message it becomes `system[i].cache_control`. On a part or message it lands on the last block (a tool message and the next user message merge into one user turn). On `tool()` it becomes `tools[i].cache_control`. At **request level** it becomes top-level `cache_control` (automatic caching). Max 4 breakpoints | Opus 5: **512**; Sonnet 5/4.6, Opus 4.8: 1024; Opus 4.6/4.5, Haiku 4.5: 4096. TTL 5 m by default or 1 h. Writes cost 1.25× (5 m) or 2× (1 h); reads 0.1× |
| **Bedrock, Converse** `amazonBedrock(id)` (Claude, Nova, others) | Explicit `cachePoint`. Claude and Nova also get *implicit*, best-effort caching | `bedrock.cachePoint: {type:'default', ttl?:'5m'\|'1h'}` becomes a `{cachePoint}` block after the system text, after a user part, at the end of a message, or after a tool-result/assistant part. **The AI SDK never emits a tools-level cachePoint** (VERIFIED(code)), but a system cachePoint caches tools+system anyway. Max 4 for Claude | The same per-model minimums as Anthropic (Opus 5: 512, Sonnet 4.6/5: 1024, Haiku 4.5: 4096), applied **cumulatively** over tools→system→messages. 1 h is only for Claude 4.5+. Longer-TTL entries must come before shorter ones |
| **Bedrock, InvokeModel Claude** `createAmazonBedrockAnthropic` (`/anthropic`) | Same as Anthropic | `anthropic.cacheControl` becomes `cache_control` (verified; `anthropic_version: bedrock-2023-05-31`). Top-level automatic caching is rejected with a 400 on the "legacy Bedrock integration (Opus ≤4.6)". UNVERIFIED for newer models | Same as above |
| **Bedrock, OpenAI GPT** (`/mantle` subpath or Responses) | Implicit; GPT-5.6 also takes explicit breakpoints | Same as the OpenAI row. UNVERIFIED through the AI SDK's Mantle wrapper | 1024 tokens. 30 min minimum TTL for 5.6 |
| **Vertex Gemini** `createGoogleVertex` | **Implicit** is on by default. **Explicit** uses a `cachedContent` resource | Implicit: nothing to set; just keep the prefix stable. Explicit: `providerOptions.vertex.cachedContent: 'projects/…/cachedContents/…'` (the `googleVertex` key also works). You create the cache with `@google/genai` (`vertexai: true`) | Implicit: 4096 tokens for Gemini 3.x, 2048 for 2.5 (per the Gemini API docs; the Vertex page wouldn't render). Explicit: 60 min default TTL, adjustable, plus a storage fee. UNVERIFIED exact Vertex numbers |
| **Vertex Claude** `createGoogleVertexAnthropic` (`/anthropic`) | Same as Anthropic | `anthropic.cacheControl` becomes `cache_control` (verified: `rawPredict`, `anthropic_version: vertex-2023-10-16`) | Same as Anthropic. Caches are scoped per organization/project |
| **Foundry, Azure OpenAI deployments** `createAzure` | Automatic. GPT-5.6+ adds explicit breakpoints | `azure.promptCacheKey` becomes `prompt_cache_key` (verified). `promptCacheRetention: 'in_memory' \| '24h'` applies to models before 5.6. For 5.6+: `promptCacheOptions: {mode, ttl:'30m'}` plus a part-level breakpoint. On Responses that is `providerOptions.azure.promptCacheBreakpoint`, because the key follows the provider name; on `azure.chat()` the part-level key is `openai` (VERIFIED(code)). PTU-M deployments don't support breakpoints | 1024 tokens, and the first 1024 must be identical. Before 5.6, hits come in 128-token increments. In-memory: 5–10 min idle, max 1 h. 24 h extended retention on gpt-4.1 through gpt-5.5 (default on for 5.5). 30 min for 5.6+ |
| **Foundry, Claude** `createAnthropic({ baseURL: 'https://<res>.services.ai.azure.com/anthropic/v1' })` | Same as Anthropic (only on the native Messages surface; **no caching through Foundry's OpenAI-compatible layer**) | `anthropic.cacheControl`. URL and `x-api-key` header verified. For Entra ID, use `Authorization: Bearer` with scope `https://ai.azure.com/.default`; that means a custom `fetch` so the token refreshes (`authToken` is static) | Same as Anthropic. Caches are per workspace |
| **Foundry, other models** (DeepSeek, Llama, Grok… via `azure.chat(deployment)`) | UNVERIFIED per model | Whatever the model's server does; `cached_tokens` is mapped if present | UNVERIFIED |
| **OpenAI API** `createOpenAI` (`openai(id)` means the Responses API) | Automatic. GPT-5.6+ adds explicit breakpoints | `openai.promptCacheKey` becomes `prompt_cache_key`, and `openai.promptCacheRetention: '24h'` becomes `prompt_cache_retention` (verified). For 5.6+: `promptCacheOptions: {mode:'implicit'\|'explicit', ttl:'30m'}` plus part-level `providerOptions.openai.promptCacheBreakpoint: {mode:'explicit'}`. On GPT-6 the provider strips `promptCacheRetention` and emits a warning | 1024 tokens. In-memory 5–10 min, up to 1 h. 24 h retention (before 5.6). 30 min minimum TTL (5.6+). **5.6+ bills cache writes** |
| **Sarvam** (`createOpenAICompatible`) | **Exists but undocumented.** The pricing page lists "cached input" at ₹10.98/M against ₹29.28/M for sarvam-105b. Almost certainly automatic | There is no documented knob | UNVERIFIED on everything |

**(d) Where the counts appear (VERIFIED(run) with fake provider responses):**

| Provider path | `cacheReadTokens` ← | `cacheWriteTokens` ← | `inputTokens` semantics | Raw or extra detail |
|---|---|---|---|---|
| Anthropic, Bedrock-invoke, Vertex-Claude, Foundry-Claude | `cache_read_input_tokens` | `cache_creation_input_tokens` | **= input + creation + read** (`noCacheTokens` = `input_tokens`) | `finalStep.providerMetadata.anthropic.usage` holds the raw payload, including `cache_creation.ephemeral_{5m,1h}_input_tokens` for 1 h billing |
| Bedrock Converse | `cacheReadInputTokens` | `cacheWriteInputTokens` | **= inputTokens + read + write** (Bedrock's own `inputTokens` field excludes cached tokens) | `providerMetadata.bedrock.usage.{cacheWriteInputTokens, cacheDetails[{ttl,…}]}`. The same data also appears under the `amazonBedrock` key |
| OpenAI, Azure (Chat and Responses) | `…_tokens_details.cached_tokens` | `…_tokens_details.cache_write_tokens` (5.6+, otherwise `undefined`) | Includes cached tokens; `noCache = total − read − write` | `usage.raw` |
| Vertex Gemini | `usageMetadata.cachedContentTokenCount` | **always `undefined`** (not reported) | `promptTokenCount`. `outputTokens` = candidates + thoughts | `providerMetadata.googleVertex` / `.vertex` `.usageMetadata` |
| Sarvam via openai-compatible | `prompt_tokens_details.cached_tokens`, *if* Sarvam sends it (UNVERIFIED) | `undefined` | `prompt_tokens` | `usage.raw` |
| `sarvam-ai-sdk` | never mapped | never mapped | lost when streaming (see §6) | — |

**The normaliser to implement.** The AI SDK has already standardised the fields, so one function covers every provider:

```ts
export function normalizeUsage(u: LanguageModelUsage, pm?: ProviderMetadata) {
  const read = u.inputTokenDetails.cacheReadTokens ?? 0, write = u.inputTokenDetails.cacheWriteTokens ?? 0, input = u.inputTokens ?? 0;
  const anth = (pm?.anthropic?.usage as any)?.cache_creation;   // for 5m vs 1h write pricing
  return { inputTokens: input, uncachedInputTokens: u.inputTokenDetails.noCacheTokens ?? Math.max(0, input - read - write),
    cachedInputTokens: read, cacheWriteTokens: write, cacheWrite1hTokens: anth?.ephemeral_1h_input_tokens ?? 0,
    outputTokens: u.outputTokens ?? 0, reasoningTokens: u.outputTokenDetails.reasoningTokens ?? 0 };
}
```

Record usage **per step** (from `onStepEnd` or the `finish-step` part), because every step is a separately billed model call. Use `result.usage` only for totals. Treat `undefined` as "not reported", not as zero, when judging cache health.

**(e) What breaks prefix reuse**, verified where marked:
- **Tool definitions render first** on Anthropic and Bedrock (order: tools → system → messages), and are part of the prefix on OpenAI.
  - `activeTools` changes the tool array, which busts the cache (the OpenAI provider docs say so explicitly).
  - On OpenAI Responses, use `providerOptions.openai.allowedTools` instead.
  - With no `toolOrder`, the AI SDK sends tools in **object insertion order**. `toolOrder: []` sorts them alphabetically. VERIFIED(run). **Always pass `toolOrder: []`**, and give MCP tools deterministic key order and JSON Schema serialisation.
- Timestamps, request IDs, user names or feature-flag branches inside `instructions` must go after the last breakpoint, in a later system entry or a message. The same applies to unsorted JSON in tool results.
- Switching models, or changing `thinking` or `effort` (and for Anthropic `tool_choice` or images), invalidates the downstream cache tiers. Pin reasoning settings per route.
- Anthropic and Bedrock look back only 20 blocks per breakpoint; long single turns need an intermediate breakpoint.
- Parallel requests can't read a cache until the first response starts streaming.
- **Bedrock strips tool-call and tool-result history when the request has no tools.** The warning says "Tool calls and results removed from conversation…". VERIFIED(run). The prefix then changes, and any cachePoint on the dropped message is lost. Always resend tool definitions.
- Gemini explicit `cachedContent` **cannot be combined with `systemInstruction`, `tools` or `toolConfig`** in the request; the API returns a 400, reported in the LangChain, LiteLLM and vercel/ai trackers. Yet the AI SDK still sends `systemInstruction` alongside `cachedContent` (VERIFIED(run)). So with explicit caching, put the system prompt and tools *inside* the cache and omit them from the call.
- Gemini 3 Flash implicit caching reportedly misses whenever tools are present (vercel/ai#11513, closed not-planned). UNVERIFIED; monitor `cacheReadTokens`.
- OpenAI and Azure: more than about 15 requests/minute on one prefix+`prompt_cache_key` pair overflows to other machines. Shard the key per tenant and agent.
- Caches never cross organization boundaries: Anthropic 1P and Foundry scope them per workspace, Bedrock and Vertex per org/project, Azure per subscription.

## 5. Provider packages: factories and credentials (VERIFIED(types); URLs VERIFIED(run))

```ts
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';            // default export name: amazonBedrock (alias bedrock)
const bedrock = createAmazonBedrock({ region: 'ap-south-1',
  credentialProvider: fromNodeProviderChain() /* @aws-sdk/credential-providers; IRSA/ECS/instance roles */,
  // or accessKeyId/secretAccessKey/sessionToken, or apiKey (AWS_BEARER_TOKEN_BEDROCK), baseURL, headers, fetch
});
bedrock('us.anthropic.claude-sonnet-4-6');   // model or inference-profile id (prefix per console); Converse: .../model/<id>/converse
import { createAmazonBedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic'; // InvokeModel, full Anthropic features
import { createBedrockMantle } from '@ai-sdk/amazon-bedrock/mantle';            // OpenAI-compatible Bedrock (gpt-oss etc.)

import { createGoogleVertex } from '@ai-sdk/google-vertex';              // alias createVertex; key 'googleVertex'|'vertex'
const vertex = createGoogleVertex({ project, location: 'global' /* or region, 'us'/'eu' */,
  googleAuthOptions: { credentials: { client_email, private_key } } /* or ADC; or apiKey = express mode */ });
import { createGoogleVertexAnthropic } from '@ai-sdk/google-vertex/anthropic'; // alias createVertexAnthropic
const vClaude = createGoogleVertexAnthropic({ project, location: 'global', googleAuthOptions /* or generateAuthToken: async () => token */ });

import { createAzure } from '@ai-sdk/azure';
const foundry = createAzure({ baseURL: 'https://<res>.services.ai.azure.com/openai/v1', // or resourceName (…openai.azure.com, ?api-version=v1)
  apiKey /* 'api-key' header */ , /* or */ tokenProvider: getBearerTokenProvider(new DefaultAzureCredential(), 'https://cognitiveservices.azure.com/.default') });
foundry('my-deployment');        // Responses API (default since v6); foundry.chat('dep') = Chat Completions; foundry.deepseek('dep')
// Foundry *project* URLs .../api/projects/<p>/openai/v1 are also accepted as-is (docs). Deployment name goes in `model`.

import { createOpenAI } from '@ai-sdk/openai';        // openai('gpt-5.5') = Responses; openai.chat() = Chat Completions
import { createAnthropic } from '@ai-sdk/anthropic';  // { apiKey (x-api-key) | authToken (Bearer), baseURL, headers, fetch }
```

- **Provider-options key per path:**
  - `anthropic`: Anthropic 1P, Bedrock-invoke, Vertex-Claude, Foundry-Claude.
  - `bedrock` (or `amazonBedrock`): Converse. Converse *also* reads `anthropic.additionalModelRequestFields`.
  - `googleVertex` or `vertex`: Vertex Gemini.
  - `azure`: Azure Responses (the `openai` key is still accepted as input; `providerMetadata` comes back as `azure`).
  - `openai`: OpenAI.
  - The name given to `createOpenAICompatible({ name })`: openai-compatible providers.
- **Reasoning:** the top-level `reasoning` option maps per provider. Provider-specific options win when both are set and the two are never merged, e.g.:
  - Anthropic: `thinking: {type:'adaptive'}` plus `effort`.
  - Bedrock: `reasoningConfig`.
  - OpenAI: `reasoningEffort`/`reasoningSummary`. With reasoning on, v7 defaults the summary to `'detailed'`; set `reasoningSummary: null` to turn that off.
- **Gotcha:** the AI SDK Anthropic provider adds `anthropic-beta: structured-outputs-2025-11-13` on requests that carry tools (seen in a run). Foundry lists structured outputs as *beta*, so confirm that Foundry-Claude accepts the header. UNVERIFIED.

## 6. Sarvam

- **API** (docs.sarvam.ai, fetched today):
  - Endpoints: `POST https://api.sarvam.ai/v1/chat/completions`. `/v2/chat/completions` serves open-source models (`glm5.3`, `gemma4`, `deepseekv4-flash`).
  - Auth: the native header is `api-subscription-key: <key>`; **`Authorization: Bearer <key>` is also accepted** for OpenAI-compatible tooling.
  - Models: `sarvam-105b` (128K context) and `sarvam-105b-conversations` (32K). Sarvam-M and sarvam-30b are **deprecated**.
  - Format: OpenAI Chat Completions shape, with `tools`/`tool_choice` (`finish_reason:'tool_calls'`) and SSE streaming.
  - Streaming: the final chunk carries `usage` with `choices: []`, then `[DONE]`. Reasoning arrives in `delta.reasoning_content`.
  - `reasoning_effort` accepts `low` | `high` | `max`; pass `null` to disable thinking. Thinking is on by default.
  - The `sarvamai` npm package (Fern-generated) is a plain REST SDK, not an AI SDK provider.
- **`sarvam-ai-sdk@0.4.4`** (repository github.com/sarvamai/sarvam-ai-sdk, peer `ai ^7`, and linked from Sarvam's own Vercel AI SDK docs page as a "community provider"):
  - It sends both auth headers and supports chat, tools, TTS, STT, translate and transliterate.
  - **However:**
    1. Streamed usage is read only from `chunk.x_sarvam.usage`. Against a standard final `usage` chunk, the result was `usage = {}` (VERIFIED(run)).
    2. It never maps cached tokens.
    3. Its stream schema reads `delta.reasoning`, not `reasoning_content`.
    4. Its `reasoning_effort` enum (`none|low|medium|high`) disagrees with the docs.
- **Recommended adapter**, VERIFIED(run): URL, both headers, `stream_options.include_usage`, and correct usage parsing:

  ```ts
  const sarvam = createOpenAICompatible({ name: 'sarvam', baseURL: 'https://api.sarvam.ai/v1', apiKey: KEY,
    headers: { 'api-subscription-key': KEY }, includeUsage: true,
    transformRequestBody: b => (noThink ? { ...b, reasoning_effort: null } : b) });
  sarvam.chatModel('sarvam-105b');   // reasoning:'low'|'high' -> reasoning_effort; providerOptions.sarvam.reasoningEffort:'max';
                                     // unknown providerOptions.sarvam.* keys (e.g. wiki_grounding) pass through to the body
  ```

  UNVERIFIED against the live API: whether v1 accepts `stream_options`, whether it returns `cached_tokens`, and whether it accepts `strict` on tools.

## 7. Testing (`ai/test`, VERIFIED(run))

`MockLanguageModelV4`, `MockProviderV4`, `mockValues` and `mockId` come from `'ai/test'`; `simulateReadableStream` comes from `'ai'` or `'ai/test'`. The V2 mocks are gone and V3 still exists.

```ts
const model = new MockLanguageModelV4({ provider: 'mock', modelId: 'm',
  doStream: [ /* array = one result per step */ { stream: simulateReadableStream({ initialDelayInMs: 30, chunkDelayInMs: 5, chunks: [
    { type: 'stream-start', warnings: [] }, { type: 'response-metadata', id: 'resp_1', modelId: 'm', timestamp: new Date(0) },
    { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Hi' }, { type: 'text-end', id: 't' },
    { type: 'tool-call', toolCallId: 'c1', toolName: 'lookupOrder', input: '{"orderId":"A1"}' },   // input is a JSON *string*
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' },
      usage: { inputTokens: { total: 1200, noCache: 200, cacheRead: 1000, cacheWrite: 0 }, outputTokens: { total: 30, text: 30, reasoning: undefined } },
      providerMetadata: { mock: { x: 1 } } } ] }), response: { headers: { 'x-request-id': 'r' } } } ],
  doGenerate: { content: [{ type: 'text', text: 'hi' }], finishReason: { unified: 'stop', raw: 'stop' }, usage: …, warnings: [] } });
model.doStreamCalls[0].prompt;   // inspect the exact LanguageModelV4Prompt incl. system providerOptions, reasoning, maxOutputTokens
```

For provider-level contract tests, pass a fake `fetch` to each `create*()` factory, as in `v2-providers.ts`. Bedrock SigV4 signs offline with dummy keys, and Vertex-Claude accepts `generateAuthToken`.

## 8. The `LanguageModelV4` spec (for a custom provider, VERIFIED(run))

`@ai-sdk/provider@4` defines:

```ts
type LanguageModelV4 = { specificationVersion: 'v4'; provider; modelId; supportedUrls: Record<string, RegExp[]> | PromiseLike<…>;
  doGenerate(o: LanguageModelV4CallOptions): PromiseLike<{ content: LanguageModelV4Content[]; finishReason: {unified, raw};
    usage: { inputTokens: {total,noCache,cacheRead,cacheWrite}; outputTokens: {total,text,reasoning}; raw? };
    providerMetadata?; request?: {body?}; response?: {id?, timestamp?, modelId?, headers?, body?}; warnings: SharedV4Warning[] }>;
  doStream(o): PromiseLike<{ stream: ReadableStream<LanguageModelV4StreamPart>; request?; response?: {headers?} }> };
```

- `CallOptions`: `{ prompt, maxOutputTokens, temperature, stopSequences, topP, topK, presencePenalty, frequencyPenalty, responseFormat, seed, tools, toolChoice, includeRawChunks, abortSignal, headers, reasoning, providerOptions }`.
- Stream parts: `stream-start`, `response-metadata`, `text-*`, `reasoning-*`, `tool-input-*`, `tool-call` (the input is a string), `tool-result`, `file`, `source`, `finish`, `raw`, `error`.
- The minimal `EchoModel` in `v7-custom.ts` type-checks and runs through `generateText` (about 30 lines).
- For HTTP providers, reuse the `@ai-sdk/provider-utils` helpers: `postJsonToApi`, `createEventSourceResponseHandler`, `combineHeaders`.

## 9. AI SDK UI: server streams and `useChat` (VERIFIED(run))

**Server (NestJS, Express or Fastify):**

```ts
const modelMessages = await convertToModelMessages(uiMessages, { tools });     // async since v6
const result = streamText({ model, instructions, messages: modelMessages, tools, toolOrder: [] });
const stream = createUIMessageStream({ originalMessages: uiMessages,           // persistence mode -> stable response message id
  execute: ({ writer }) => { writer.write({ type: 'data-status', data: { phase: 'thinking' }, transient: true });
                             writer.merge(toUIMessageStream({ stream: result.stream, tools, sendReasoning: false })); },
  onEnd: ({ messages, responseMessage }) => persist(messages), onError: () => 'Something went wrong' });  // default masks errors
await pipeUIMessageStreamToResponse({ response: res /* node ServerResponse */, stream, headers: { 'x-ocso-trace': id } });
// Fastify: reply.hijack(); await pipeUIMessageStreamToResponse({ response: reply.raw, stream });  (both verified)
// Fetch-style handlers: return createUIMessageStreamResponse({ stream });
```

- The response is SSE (`data: {…}\n\n` … `data: [DONE]`). It carries `content-type: text/event-stream`, `x-vercel-ai-ui-message-stream: v1`, `x-accel-buffering: no` and `cache-control: no-cache`.
- Chunks seen: `start` (with `messageId`), `start-step`, `text-*`, and `tool-input-available` for no-execute tools (the client sees a tool part in the `input-available` state), then `finish-step`, `finish` (with `finishReason`) and custom `data-*`.
- The `result.toUIMessageStreamResponse`/`pipeUIMessageStreamToResponse` methods are deprecated in v7.
- `UIMessage` has **no `providerOptions`**. Build model messages server-side from our own store and add the cache markers there.

**Client (`@ai-sdk/react@4.0.112`, React 18 or 19):**

```tsx
import { useChat } from '@ai-sdk/react'; import { DefaultChatTransport } from 'ai';
const { messages, sendMessage, status /* 'submitted'|'streaming'|'ready'|'error' */, error, stop, regenerate,
        resumeStream, addToolOutput, addToolApprovalResponse, setMessages, clearError } =
  useChat({ id: conversationId, transport: new DefaultChatTransport({ api: '/v1/webchat/messages',
    headers: () => ({ Authorization: `Bearer ${token()}` }), body: { channel: 'web' }, credentials: 'include',
    prepareSendMessagesRequest: ({ messages, id }) => ({ body: { id, message: messages.at(-1) } }) }),   // send only the new message
    throttle: 50, resume: false, onFinish, onError, onData /* data-* parts */ });
sendMessage({ text, files? }, { headers?, body?, metadata? });
```

`HttpChatTransport` and `TextStreamChatTransport` exist as well, and `DirectChatTransport` runs in-process.

## 10. Breaking changes we must not get wrong

- **v5 → v6:**
  - `CoreMessage` and `convertToCoreMessages` were removed; use `ModelMessage` and the now-async `convertToModelMessages`.
  - `toModelOutput({ output })` now takes an object.
  - The `name` property was removed from `tool()`; `ToolCallOptions` became `ToolExecutionOptions`.
  - Per-tool `strict` replaced `strictJsonSchema`, which now defaults to `true` on OpenAI.
  - `textEmbeddingModel` became `embeddingModel`.
  - The `'unknown'` finish reason became `'other'`.
  - `azure()` now means the **Responses API**, with the provider-metadata key `azure`.
  - The Vertex provider-metadata key changed from `google` to `vertex`.
  - `ai/test` moved to the V3 mocks.
- **v6 → v7:**
  - ESM-only; Node ≥22.
  - `system` became `instructions`, and a system message inside `messages` now **throws**.
  - `stepCountIs` became `isStepCount`.
  - `usage` now means all steps; `totalUsage` is deprecated; `finalStep.*` holds last-step data.
  - `content`, `toolCalls`, `toolResults`, `warnings` and similar result arrays now accumulate across steps.
  - `step.response.messages` is no longer cumulative; use `result.responseMessages`.
  - `prepareStep` overrides of `instructions` and `messages` now **carry forward** to later steps.
  - `fullStream` became `stream`; `onFinish` became `onEnd`; `onStepFinish` became `onStepEnd`.
  - `onChunk` now sees every part.
  - Request and response bodies are no longer kept by default (`include`).
  - OTel moved to `@ai-sdk/otel` and is on by default once registered.
  - `cachedInputTokens`/`reasoningTokens` were removed, as was Anthropic `cacheCreationInputTokens`; both now live in `inputTokenDetails`.
  - The `image` part is deprecated in favour of `file` with an `image` media type, and the `media` tool-output part became `file`.
  - `needsApproval` became `toolApproval`; `experimental_context` became `context` plus `toolsContext`/`runtimeContext`.
  - The MCP transport default is now `redirect: 'error'`.
  - The OpenAI `reasoningSummary` now defaults to `'detailed'`.
  - Codemods: `npx @ai-sdk/codemod v7`.

## 11. Recommended adapter approach per provider

| OCSO provider | Package / factory | Model handle | Cache strategy (§4) | Notes |
|---|---|---|---|---|
| AWS Bedrock | `@ai-sdk/amazon-bedrock` `createAmazonBedrock({ region, credentialProvider })` | `bedrock('global.anthropic.claude-…')`, Nova ids | `bedrock.cachePoint` on the last static system entry, plus one on the stable history boundary | Always send tools, because tool history gets stripped otherwise. Use `/anthropic` (InvokeModel) only for Claude-only features |
| Google Vertex AI | `@ai-sdk/google-vertex` `createGoogleVertex` + `/anthropic` `createGoogleVertexAnthropic` | `vertex('gemini-3.1-pro-preview')`, `vClaude('claude-sonnet-4-6')` | Gemini: implicit only, with a stable prefix. Claude: `anthropic.cacheControl` | Avoid explicit `cachedContent` unless system and tools live in the cache |
| Microsoft Foundry | `@ai-sdk/azure` `createAzure({ baseURL: …/openai/v1, tokenProvider })`; Claude via `@ai-sdk/anthropic` with baseURL `…/anthropic/v1` | the deployment name | `azure.promptCacheKey` per tenant+agent; Claude via `cacheControl` | No official Foundry package. Claude needs an Entra token-refresh `fetch` wrapper |
| OpenAI API | `@ai-sdk/openai` `createOpenAI` | `openai('gpt-5.5')` (Responses) | `promptCacheKey` (+ `promptCacheRetention:'24h'` before 5.6; breakpoints on 5.6+) | Consider `store: false` for data minimisation |
| Anthropic API | `@ai-sdk/anthropic` `createAnthropic` | `anthropic('claude-sonnet-4-6')` | Explicit `cacheControl` on the static system entry, plus request-level `cacheControl` (automatic) for the growing tail | Max 4 breakpoints |
| Sarvam | `@ai-sdk/openai-compatible` `createOpenAICompatible` (see §6) | `sarvam.chatModel('sarvam-105b')` | None (automatic or undocumented) | Revisit `sarvam-ai-sdk` only for TTS/STT; don't use it for chat accounting |

Every adapter should wrap the same `streamText` call. Per provider, it varies only the model handle, the `providerOptions` builder (cache markers and keys), and the usage and ID extractor (§3 and §4d). All six were driven through the same code path in `v2-providers.ts`.

## UNVERIFIED / open items

- Live-API behaviour for everything except request and response *shapes*. No real provider calls were made.
- The exact Vertex implicit-cache minimums and explicit-cache TTL limits. The numbers above are Gemini API figures, plus a Vertex search snippet.
- Minimum cacheable tokens for Opus 4.7: Anthropic's prompt-caching reference says 2048, AWS's Bedrock table says 4096.
- Sarvam: prompt-cache mechanics and reporting, whether it accepts `stream_options`, and `strict` tools.
- Caching for non-OpenAI, non-Claude Foundry models. Whether Foundry-Claude accepts every `anthropic-beta` header the AI SDK sends.
- The Mantle (`/mantle`) GPT-5.6 cache options through the AI SDK.
- Whether top-level Anthropic `cacheControl` (automatic caching) works on Bedrock InvokeModel for Claude 4.7+.
