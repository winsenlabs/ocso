# Anthropic

This guide connects the Anthropic API (Claude models, called directly) to OCSO as the `ANTHROPIC` provider kind
(label **Anthropic API**). It is for the Tech admin who configures models. The adapter uses `@ai-sdk/anthropic`; its
definition is
[packages/model-providers/src/providers/anthropic/definition.ts](../../../packages/model-providers/src/providers/anthropic/definition.ts).
For Claude through AWS, Google or Azure, use [AWS Bedrock](aws-bedrock.md), [Google Vertex AI](google-vertex.md) or
[Microsoft Foundry](microsoft-foundry.md) instead.

> [!NOTE]
> Request bodies, cache directives, streaming and usage mapping are verified against recorded Anthropic-format
> responses. The adapter is not run against a live Anthropic account in CI. Use **Test** after you configure it.

## Prerequisites

- An Anthropic API key from the Claude Console (starts with `sk-ant-`).
- A Tech admin (`providers.manage`) to add the provider, and a second person with `approvals.check.platform` to
  approve enabling it.
- Outbound https from the api and worker to `api.anthropic.com` (or your gateway).

## Fields

| Label | Key | Required | Notes |
|---|---|---|---|
| **Base URL** | `settings.baseURL` | no | https only. Default `https://api.anthropic.com/v1`. For a proxy or gateway. |
| **Health model** | `settings.healthModel` | no | Model the health probe uses. Built-in default `claude-haiku-4-5`. |
| **Capability overrides** | `settings.capabilityOverrides` | no | JSON per model id; see the [models overview](README.md#what-every-provider-form-has). |
| **Api key** | `credentials.apiKey` | yes | Write-only. Sent as `x-api-key`. |

Declare **Region (optional)** and **Data residency zone (optional)** yourself if your deployment policy needs them.

## Steps

1. **Integrations → Models**, then **Configure** on the **Anthropic API** card.
2. Enter a **Name** and the **Api key**. Optionally set **Health model**.
3. Click **Add provider (draft)**, then **Test** on the card.
4. Click **Enable**; a second person approves it under **Approvals**.
5. Create a [model profile](profiles-and-pricing.md) that uses it.

## Prompt caching

Anthropic caching is explicit. With **Cache policy** **Prefix cache**, OCSO places `cache_control` breakpoints (at
most 4) at the prompt compiler's stable sites: the agent prefix, the conversation context and the history. **Cache
TTL** **1 hour** sends `ttl: '1h'`; otherwise the 5-minute default applies. OCSO also turns off tool input streaming
(`toolStreaming: false`) so tool definitions are identical between streaming and non-streaming calls and do not
break the cached prefix.

Card summary: **explicit cache_control breakpoints**. Cache reads and writes are both reported and recorded.

> [!NOTE]
> 1-hour cache writes are priced at the 5-minute write rate (PM/research/09 §8). Enter a manual price if the
> difference matters to you.

## Model discovery

`GET {Base URL}/models?limit=1000`, following `after_id` pages. Each model's `display_name`, `created_at`,
`max_input_tokens` and `max_tokens` are used, and `capabilities.image_input` / `pdf_input` become input kinds.

## Capabilities OCSO assumes

Every Claude model: image and file input, tool calling, structured output, streaming, explicit caching with cache
writes reported. Reasoning is on except for models before Claude 3.7 (`claude-instant`, `claude-2`, Claude 3 Haiku, Sonnet and
Opus, and Claude 3.5). Audio input is off.

## Verify it works

- **Test** passes and shows the reply preview.
- In **System → Telemetry**, the profile shows cache reads after a few turns of the same conversation.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| **test failed**, authentication | Wrong key, or a workspace key without access to the model. |
| No cache reads | The prompt prefix is below the model's minimum cacheable length, or the profile's **Cache policy** is **Off**. |
| Cost shows "no price" | A dated snapshot id the catalog does not list exactly. Use the undated id or add a manual price. |

## Limits and known gaps

- Batch and data-residency surcharges are not priced.
- Not verified against a live account in CI (see the note above).

## Related

- [Model providers overview](README.md)
- [Profiles, fallbacks and pricing](profiles-and-pricing.md)
- [AWS Bedrock](aws-bedrock.md) · [Google Vertex AI](google-vertex.md) · [Microsoft Foundry](microsoft-foundry.md)
