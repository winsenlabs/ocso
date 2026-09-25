# Google Vertex AI

This guide connects Google Cloud Vertex AI to OCSO as the `VERTEX` provider kind (label **Google Vertex AI**). One
provider serves both Gemini models and Claude models from the Vertex Model Garden. It is for the Tech admin who
configures models. The definition is
[packages/model-providers/src/providers/vertex/definition.ts](../../../packages/model-providers/src/providers/vertex/definition.ts).

> [!WARNING]
> Request bodies, caching and usage mapping are verified against recorded Vertex-format responses only. The model
> listing (Model Garden publisher models) was built to Google's documented shape and has **never been checked
> against a live GCP project**; the mapping of dated Claude versions to `@YYYYMMDD` ids in particular still needs a
> live look (PM/research/09 §4). Run **Test** and check the model picker before relying on it.

## Prerequisites

At Google Cloud:

- A project with the Vertex AI API enabled, and access to the models you will call (Claude models on Vertex must be
  enabled in Model Garden).
- A service account with a role that can call models, such as **Vertex AI User** (`roles/aiplatform.user`).
- Either a JSON key for that service account, or Application Default Credentials (ADC) available to the api and
  worker (for example an attached service account on GCE/GKE, or `GOOGLE_APPLICATION_CREDENTIALS`).

In OCSO: a Tech admin (`providers.manage`) and a second person with `approvals.check.platform`.

## Fields

| Label | Key | Required | Notes |
|---|---|---|---|
| **Project** | `settings.project` | no | GCP project id. Defaults to the key's `project_id`. Required in `APPLICATION_DEFAULT` mode. |
| **Location** | `settings.location` | no | `global`, a multi-region (`us`, `eu`) or a region (`asia-south1`). Falls back to the record's **Region (optional)**, then `global`. |
| **Auth mode** | `settings.authMode` | no | `SERVICE_ACCOUNT_KEY` (default) or `APPLICATION_DEFAULT`. |
| **Health model** | `settings.healthModel` | no | Model the **Test** button probes, e.g. a `gemini-…` id. No built-in default. |
| **Capability overrides** | `settings.capabilityOverrides` | no | JSON per model id. |
| **Service account json** | `credentials.serviceAccountJson` | with `SERVICE_ACCOUNT_KEY` | Paste the whole key file. Write-only. |

With a key, OCSO signs its own JWT bearer grant (scope `https://www.googleapis.com/auth/cloud-platform`) and caches
the access token until a minute before it expires. The key's private key and key id are scrubbed from every error.
With ADC, `google-auth-library` finds the credentials. OCSO pins OAuth, so an ambient `GOOGLE_VERTEX_API_KEY` cannot
switch it to express mode.

## Steps

1. **Integrations → Models**, then **Configure** on the **Google Vertex AI** card.
2. Enter a **Name**. Set **Location** (or the record's region) and a **Data residency zone** if your policy needs one
   (for example `IN` for `asia-south1`; `global` endpoints may process data anywhere).
3. Choose **Auth mode**. For `SERVICE_ACCOUNT_KEY`, paste the key into **Service account json**. For
   `APPLICATION_DEFAULT`, set **Project**.
4. Set **Health model** to a Gemini model you can call.
5. **Add provider (draft)**, **Test**, then **Enable** and have a second person approve it.

## Model ids

- Gemini: the id as Google lists it, e.g. `gemini-…`.
- Claude: the Vertex id. Current (4.6 and later) models are dateless; older snapshots are called as
  `claude-…@YYYYMMDD`. Any id containing `claude` is sent to the Anthropic-on-Vertex endpoint; everything else to
  Gemini.

## Prompt caching

Card summary: **implicit prefix (Gemini) · cache_control (Claude)**.

- **Gemini**: implicit caching only. OCSO sends no cache directives; it keeps the prefix stable. Explicit
  `cachedContent` is not used, because the SDK also sends the system instruction and tools, which the API rejects
  alongside cached content. Gemini reports cache reads only, not writes.
- **Claude on Vertex**: the same explicit `cache_control` breakpoints as the [Anthropic API](anthropic.md#prompt-caching)
  (at most 4, `ttl: '1h'` on request).

## Model discovery

`GET https://<host>/v1/publishers/google/models` and `.../publishers/anthropic/models` (paged), with the bearer token
and `x-goog-user-project: <project>`. The host is `aiplatform.googleapis.com` for `global` and multi-regions, and
`<region>-aiplatform.googleapis.com` otherwise. OCSO keeps `gemini-*` models that are not embedding, TTS, image or
live/native-audio variants, and every `claude-*` model. The listing documents no input kinds or limits; those come
from the catalog.

## Capabilities OCSO assumes

Gemini: image, file and audio input, tools, structured output, streaming, automatic caching; reasoning for Gemini
2.5 and later. Claude: as on [Anthropic](anthropic.md#capabilities-ocso-assumes).

## Verify it works

- **Test** passes.
- The model picker lists Gemini and Claude models for your location.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `A GCP project id is required` | `APPLICATION_DEFAULT` mode without **Project**, or a key without `project_id`. |
| `The Google service account key is not valid JSON` / `is incomplete` | The pasted key is truncated or not a service-account key (`client_email` and `private_key` are required). |
| `Google Application Default Credentials could not be obtained` | ADC is not available to the api or worker process. |
| Permission denied | The service account lacks a Vertex AI role, or Claude is not enabled in Model Garden for the project. |
| Claude model not found | Region does not offer that model, or an older model needs its `@YYYYMMDD` suffix. |

## Limits and known gaps

- Listing never checked against a live project (see the warning above).
- No explicit Gemini context caching.
- Publishers other than `google` and `anthropic` (Llama, Mistral on Vertex) are not listed or supported.

## Related

- [Model providers overview](README.md)
- [Profiles, fallbacks and pricing](profiles-and-pricing.md)
- [Anthropic](anthropic.md)
