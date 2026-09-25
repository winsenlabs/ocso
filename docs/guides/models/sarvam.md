# Sarvam AI

This guide connects Sarvam AI to OCSO as the `SARVAM` provider kind (label **Sarvam AI**). Sarvam serves Indian-
language models through an OpenAI-compatible Chat Completions API. It is for the Tech admin who configures models.
The definition is
[packages/model-providers/src/providers/sarvam/definition.ts](../../../packages/model-providers/src/providers/sarvam/definition.ts).

> [!WARNING]
> Sarvam is the least verified provider. Request bodies and usage mapping are checked against recorded
> OpenAI-compatible responses. Whether Sarvam reports cached tokens, and how its caching works, is **unknown**:
> Sarvam's pricing page lists a cached-input price but documents no cache control. Run **Test** and watch
> **System → Telemetry** before relying on it.

OCSO uses `@ai-sdk/openai-compatible` rather than `sarvam-ai-sdk`, because the latter drops usage on streamed
responses.

## Prerequisites

- A Sarvam API subscription key from the Sarvam dashboard.
- A Tech admin (`providers.manage`) and a second person with `approvals.check.platform`.
- Outbound https to `api.sarvam.ai`.

## Fields

| Label | Key | Required | Notes |
|---|---|---|---|
| **Base URL** | `settings.baseURL` | no | https. Default `https://api.sarvam.ai/v1`. |
| **Health model** | `settings.healthModel` | no | Built-in default `sarvam-105b`. |
| **Capability overrides** | `settings.capabilityOverrides` | no | JSON per model id. |
| **Api key** | `credentials.apiKey` | yes | The subscription key. Sent both as `api-subscription-key` and as a bearer token. |

OCSO does not infer where Sarvam keeps data. Set **Data residency zone** (for example `IN`) to match your contract
with Sarvam if your deployment policy requires a zone.

## Steps

1. **Integrations → Models**, then **Configure** on the **Sarvam AI** card.
2. Enter a **Name**, the **Api key**, and optionally **Region** and **Data residency zone**.
3. **Add provider (draft)**, **Test**, then **Enable** and have a second person approve it.

## Reasoning

Sarvam's models think by default. The profile's **Reasoning** maps to Sarvam's `reasoning_effort` like this:

| Profile **Reasoning** | Sent |
|---|---|
| **Off** | `reasoning_effort: null` (thinking off) |
| **Low** | `low` |
| **Medium** or **Provider default** | nothing (Sarvam's default) |
| **High** | `high` |

The **Test** call turns thinking off so it fits in its small output budget.

## Prompt caching

Card summary: **no documented control · unverified**. OCSO sends no cache directives. If Sarvam returns
`prompt_tokens_details.cached_tokens`, OCSO records cache reads; otherwise cache columns show "n/r".

## Model discovery

OpenAI-compatible `GET {Base URL}/models`. If Sarvam answers 404, the listing reports
`model_listing_unsupported` and the model picker falls back to the models the models.dev catalog lists for Sarvam.

## Capabilities OCSO assumes

Text only (no image, file or audio input), tool calling, reasoning and streaming; no structured output; caching
unverified. Override with **Capability overrides** if a model does more.

## Pricing

models.dev lists Sarvam models, but not always with prices, and LiteLLM lists Sarvam only through resellers. Expect
to enter manual prices; note that catalog and manual prices are in USD while Sarvam bills in INR.

## Verify it works

- **Test** passes.
- A conversation on a Sarvam profile shows tokens in **System → Telemetry**.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| **test failed**, authentication | Wrong subscription key. |
| Replies are slow or cut off | Thinking is on by default; set the profile's **Reasoning** to **Off** or **Low**, or raise **Max output tokens**. |
| Cost shows "no price" | No catalog price; add a manual one. |

## Limits and known gaps

- Caching behaviour and cached-token reporting are unverified.
- No image, file or audio input through this adapter.
- Prices are USD in OCSO.

## Related

- [Model providers overview](README.md)
- [Profiles, fallbacks and pricing](profiles-and-pricing.md)
