# OpenAI

This guide connects the OpenAI API to OCSO as the `OPENAI` provider kind (label **OpenAI API**). It is for the
Tech admin who configures models. The adapter uses the Responses API through `@ai-sdk/openai`; its definition is
[packages/model-providers/src/providers/openai/definition.ts](../../../packages/model-providers/src/providers/openai/definition.ts).

> [!NOTE]
> Request bodies, streaming, tool calls and usage mapping are verified against recorded OpenAI-format responses.
> The adapter is not run against a live OpenAI account in CI. Use **Test** after you configure it.

## Prerequisites

At OpenAI:

- An API key (a project key is fine) with access to the models you want. Keys start with `sk-`.
- Optional: your organization id and project id, if the key belongs to more than one.

In OCSO:

- A Tech admin (`providers.manage`) to add the provider, and a second person with `approvals.check.platform`
  (a Head or another Tech admin) to approve enabling it.
- Outbound https from the api and worker to `api.openai.com` (or your gateway).

## Fields

| Label | Key | Required | Notes |
|---|---|---|---|
| **Base URL** | `settings.baseURL` | no | https only. Default `https://api.openai.com/v1`. Set it for a proxy or gateway that speaks the OpenAI API. |
| **Organization** | `settings.organization` | no | Sent as `OpenAI-Organization`. |
| **Project** | `settings.project` | no | Sent as `OpenAI-Project`. |
| **Store responses** | `settings.storeResponses` | no | Default off: OCSO sends `store: false` so OpenAI does not keep responses (data minimisation). |
| **Explicit cache breakpoints** | `settings.explicitCacheBreakpoints` | no | **Provider decides** (default: on for GPT-5.6 and later, detected from the model id), **On** or **Off**. |
| **Health model** | `settings.healthModel` | no | Model the **Test** button probes, e.g. `gpt-5.5`. No built-in default. |
| **Capability overrides** | `settings.capabilityOverrides` | no | JSON per model id; see the [models overview](README.md#what-every-provider-form-has). |
| **Api key** | `credentials.apiKey` | yes | Write-only. |

**Region (optional)** and **Data residency zone (optional)** on the provider record are yours to declare: OpenAI
does not report them. Set the zone (for example `US`) if your deployment policy requires one.

## Steps

1. Go to **Integrations → Models** and click **Configure** on the **OpenAI API** card (or **Add provider** and pick
   **OpenAI API**).
2. Enter a **Name**, optionally **Region** and **Data residency zone**, then paste the key into **Api key**. Set
   **Health model** to a model your key can call.
3. Click **Add provider (draft)**.
4. On the new card, click **Test**. A passing test shows **test passed**, the model, the latency and the start of
   the reply to "Reply with OK".
5. Click **Enable** and have a second person approve it under **Approvals**.
6. Create a model profile that uses it: [Profiles, fallbacks and pricing](profiles-and-pricing.md).

## Prompt caching

OpenAI caches prompt prefixes automatically. With a profile **Cache policy** of **Prefix cache**, OCSO adds:

- `promptCacheKey` per agent prefix, so requests that share a prefix are routed to the same cache.
- Before GPT-5.6: **Cache TTL** of **1 hour** sends `promptCacheRetention: '24h'` (extended retention).
- GPT-5.6 and later (or **Explicit cache breakpoints** on): explicit part-level breakpoints at the compiler's cache
  sites (at most 4) and `promptCacheOptions` with `mode: 'implicit'`; a 1-hour TTL becomes a 30-minute implicit
  retention. These models bill cache writes, and OCSO records them.

The provider card shows **automatic · prompt cache key**. With **Cache policy** **Off**, no cache options are sent
(only `store`).

## Model discovery

OCSO calls `GET {Base URL}/models` with the key. The listing has no prices or capabilities, and it mixes every model
family, so OCSO drops ids that are not chat models: anything containing `embedding`, `whisper`, `transcribe`, `tts`,
`audio`, `realtime`, `dall-e`, `gpt-image`, `image`, `sora`, `moderation`, `search-preview`, `computer-use`, ids
starting with `davinci` or `babbage`, and `-instruct` models (`OPENAI_NON_CHAT` in
[discovery/openai.ts](../../../packages/model-providers/src/discovery/openai.ts)). Fine-tunes (`ft:…`) are listed.
Context window and input kinds come from the catalog when it knows the model.

## Capabilities OCSO assumes

From the model id ([shared/model-families.ts](../../../packages/model-providers/src/providers/shared/model-families.ts)):
tool calling, structured output and streaming for every model; image and file input except `gpt-3.5`, `o1-mini`
and `o3-mini`; reasoning for `o*`, `gpt-5*` and later. Audio input is off. Correct any of these with **Capability
overrides**.

## Verify it works

- **Test** on the card passes.
- The profile dialog's model picker lists your models.
- After a conversation, **System → Telemetry** shows requests, tokens and cache reads for the profile.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| **test failed** with an authentication code | Wrong or revoked key, or the key's project cannot use the model. |
| Picker shows an error and free text only | The listing failed (bad key, outage, a gateway without `/models`). You can still type the model id. |
| `max_output_tokens` errors on tests | Gateways that do not accept 16 as a minimum. OCSO's test uses 16, the Responses API minimum. |
| Cost shows "no price" | The catalog does not list the exact model id (dated snapshots and fine-tunes often are not). Add a manual price. |

## Limits and known gaps

- Only the Responses API is used; there is no Chat Completions mode for OpenAI itself (Foundry deployments can use
  Chat Completions).
- Audio input is not supported through this adapter.
- Batch, priority/fast mode and data-residency surcharges are not priced; enter a manual price if you use them.

## Related

- [Model providers overview](README.md)
- [Profiles, fallbacks and pricing](profiles-and-pricing.md)
- [Microsoft Foundry](microsoft-foundry.md) for OpenAI models deployed on Azure
