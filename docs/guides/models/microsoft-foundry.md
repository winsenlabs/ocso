# Microsoft Foundry (Azure)

This guide connects Microsoft Foundry (formerly Azure AI Foundry, including Azure OpenAI deployments) to OCSO as the
`FOUNDRY` provider kind (label **Microsoft Foundry**). One provider covers every deployment on a Foundry resource:
OpenAI models, Claude models and other models such as DeepSeek, Llama or Grok. It is for the Tech admin who
configures models. The definition is
[packages/model-providers/src/providers/foundry/definition.ts](../../../packages/model-providers/src/providers/foundry/definition.ts)
and its settings schema
[foundry/settings.ts](../../../packages/model-providers/src/providers/foundry/settings.ts).

> [!NOTE]
> There is no official AI SDK package for Foundry. OCSO uses `@ai-sdk/azure` for OpenAI-family deployments and
> `@ai-sdk/anthropic` for Claude deployments. Both paths are verified against recorded responses; neither is run
> against a live Azure resource in CI.

## How Foundry differs

In Foundry the "model id" OCSO sends is your **deployment name**, which says nothing about the model behind it. So
you declare each deployment's model family in **Deployments**. That declaration decides the API surface, the
caching directives, the capabilities OCSO assumes and how the deployment is priced.

| Family | Endpoint | API | Caching |
|---|---|---|---|
| `openai` | `https://<resource>.services.ai.azure.com/openai/v1` | Responses (default) or Chat Completions | prompt cache key (and explicit breakpoints on GPT-5.6+) |
| `anthropic` | `https://<resource>.services.ai.azure.com/anthropic/v1` | Anthropic Messages | explicit `cache_control` |
| `other` | `…/openai/v1` | Chat Completions | none sent; cached tokens recorded if reported |

Claude on Foundry lives at the resource level, so its URL is built from the endpoint's origin even when you give a
project endpoint.

## Prerequisites

At Azure:

- A Foundry resource with the model deployments you need. Note each deployment's name and underlying model.
- Either the resource's API key, or a Microsoft Entra ID identity with access to the resource (for example the
  **Cognitive Services OpenAI User** role, and whatever role your Claude deployments require).

In OCSO: a Tech admin (`providers.manage`) and a second person with `approvals.check.platform`.

## Fields

| Label | Key | Required | Notes |
|---|---|---|---|
| **Resource name** | `settings.resourceName` | one of these two | Builds `https://<resourceName>.services.ai.azure.com`. |
| **Endpoint** | `settings.endpoint` | one of these two | Resource or project endpoint URL (https), instead of **Resource name**. |
| **Auth mode** | `settings.authMode` | no | `API_KEY` (default) or `ENTRA_ID`. |
| **Deployments** | `settings.deployments` | no | JSON map of deployment name to its family; see below. |
| **Default model family** | `settings.defaultModelFamily` | no | Family assumed for deployments not listed: `openai` (default), `anthropic` or `other`. |
| **Store responses** | `settings.storeResponses` | no | Default off (`store: false` on the Responses API). |
| **Health model** | `settings.healthModel` | no | A deployment name the **Test** button probes. |
| **Capability overrides** | `settings.capabilityOverrides` | no | JSON keyed by deployment name. |
| **Api key** | `credentials.apiKey` | with `API_KEY` | Write-only. |
| **Tenant id** | `credentials.tenantId` | no | With client id and secret: a service principal. |
| **Client id** | `credentials.clientId` | no | Alone: selects a user-assigned managed identity. |
| **Client secret** | `credentials.clientSecret` | no | Service principal secret. |

### Deployments

**Deployments** is a JSON object. Each key is a deployment name; each value has:

- `modelFamily`: `openai`, `anthropic` or `other` (required).
- `model`: the underlying model (e.g. `gpt-5.5`, `claude-sonnet-4-6`). Used for capability heuristics and pricing.
  Strongly recommended.
- `api`: `RESPONSES` (default) or `CHAT_COMPLETIONS`. OpenAI family only.
- `explicitCacheBreakpoints`: `true` or `false` to force GPT-5.6+ breakpoints. OpenAI family only.

```json
{
  "gpt55-prod": { "modelFamily": "openai", "model": "gpt-5.5" },
  "sonnet-support": { "modelFamily": "anthropic", "model": "claude-sonnet-4-6" },
  "deepseek-r1": { "modelFamily": "other", "model": "DeepSeek-R1" }
}
```

### Entra ID

With `ENTRA_ID`, OCSO gets bearer tokens from `@azure/identity`:

- Tenant id + client id + client secret set: `ClientSecretCredential` (a service principal).
- Otherwise: `DefaultAzureCredential` (managed identity, workload identity, environment variables of the api and
  worker); a **Client id** alone selects a user-assigned managed identity.

Token scopes: `https://cognitiveservices.azure.com/.default` for the OpenAI surface and `https://ai.azure.com/.default`
for Claude. Tokens are cached and refreshed per request.

## Steps

1. **Integrations → Models**, then **Configure** on the **Microsoft Foundry** card.
2. Enter a **Name**, the **Region (optional)** of the resource (e.g. `centralindia`), and a **Data residency zone**
   if your policy needs one.
3. Fill in **Resource name** or **Endpoint**, **Auth mode** and the matching credentials.
4. Paste your **Deployments** JSON, and set **Health model** to one of the deployment names.
5. **Add provider (draft)**, **Test**, then **Enable** and have a second person approve it.

## Prompt caching

Card summary: **prompt cache key (OpenAI) · cache_control (Claude)**. Per deployment:

- `openai`: as on the [OpenAI API](openai.md#prompt-caching): `promptCacheKey`, 24-hour retention for a 1-hour TTL
  before GPT-5.6, explicit breakpoints on GPT-5.6+. Provisioned (PTU-M) deployments do not support breakpoints;
  set `explicitCacheBreakpoints: false` for them.
- `anthropic`: as on the [Anthropic API](anthropic.md#prompt-caching).
- `other`: no directives; caching is **unverified**.

## Model discovery

Foundry has no listing an inference key can call (listing deployments needs Azure control-plane access), so the
model picker shows exactly the deployments you declared in **Deployments**, as `name (model)`. Deployments not
declared can still be typed; they use **Default model family**.

## Pricing

A deployment is priced by its declared `model` (else by the deployment name, since Foundry names deployments after
the model by default), looked up as models.dev `azure` and LiteLLM `azure/…` and `azure_ai/…`. Declare `model` for
every deployment you want priced from the catalog.

## Verify it works

- **Test** passes against the **Health model** deployment.
- The model picker lists your declared deployments.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `resourceName or endpoint is required` | Neither field is set. |
| `A Foundry API key is required` | **Auth mode** `API_KEY` without **Api key**. |
| 404 on a Claude deployment | The deployment is declared `openai` (or not declared, with default `openai`). Set `modelFamily: "anthropic"`. |
| 401 with Entra ID | The identity lacks a data-plane role on the resource, or `DefaultAzureCredential` found no identity in the process. |
| Unexpected capability errors | Declare `model` so heuristics apply, or use **Capability overrides**. |

## Limits and known gaps

- Deployments are not discovered; you maintain the **Deployments** JSON.
- `other`-family deployments get conservative capabilities (text only, tool calling, no structured output) until you
  override them.
- Not run against a live Azure resource in CI.

## Related

- [Model providers overview](README.md)
- [Profiles, fallbacks and pricing](profiles-and-pricing.md)
- [OpenAI](openai.md) · [Anthropic](anthropic.md)
