# AWS Bedrock

This guide connects Amazon Bedrock to OCSO as the `BEDROCK` provider kind (label **AWS Bedrock**). It is for the
Tech admin who configures models. The adapter calls the Converse / ConverseStream API through
`@ai-sdk/amazon-bedrock`; its definition is
[packages/model-providers/src/providers/bedrock/definition.ts](../../../packages/model-providers/src/providers/bedrock/definition.ts).

> [!WARNING]
> Request bodies, cache points and usage mapping are verified against recorded Bedrock-format responses only. The
> model listing (ListFoundationModels and ListInferenceProfiles) was built to AWS's documented shapes and has
> **never been run against a live AWS account**. Run **Test** and check the model picker before relying on it.

## Prerequisites

At AWS:

- Model access granted in the Bedrock console for each model you will use, in the region you will call.
- One of three ways to authenticate (see **Auth mode** below): an IAM user's access keys, an IAM role the api and
  worker already run as, or a Bedrock API key.
- IAM permissions for that identity: `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on the model
  and inference-profile ARNs, and for model discovery `bedrock:ListFoundationModels` and
  `bedrock:ListInferenceProfiles`.

> [!IMPORTANT]
> The Terraform stack in `infra/aws` grants the api and worker task roles only `bedrock:InvokeModel` and
> `bedrock:InvokeModelWithResponseStream`, on the ARNs in the `bedrock_model_arns` variable. It does not grant the
> two List actions, so with **Auth mode** `IAM_ROLE` on that stack the model picker shows a listing error and you
> type model ids by hand. Add the List actions to the task role if you want discovery.

In OCSO: a Tech admin (`providers.manage`) and a second person with `approvals.check.platform`.

## Fields

| Label | Key | Required | Notes |
|---|---|---|---|
| **Region** | `settings.region` | no | e.g. `ap-south-1`. When empty, the provider record's **Region (optional)** is used. One of the two is required. |
| **Auth mode** | `settings.authMode` | no | `ACCESS_KEYS` (default), `IAM_ROLE` or `API_KEY`. |
| **Base URL** | `settings.baseURL` | no | https. A VPC interface endpoint or proxy for `bedrock-runtime`. |
| **Health model** | `settings.healthModel` | no | Model or inference-profile id the **Test** button probes. No built-in default. |
| **Capability overrides** | `settings.capabilityOverrides` | no | JSON per model id. Useful for models the family heuristics misjudge. |
| **Access key id** | `credentials.accessKeyId` | with `ACCESS_KEYS` | Write-only. |
| **Secret access key** | `credentials.secretAccessKey` | with `ACCESS_KEYS` | Write-only. |
| **Session token** | `credentials.sessionToken` | no | For temporary credentials. They expire; prefer `IAM_ROLE` for anything long-lived. |
| **Api key** | `credentials.apiKey` | with `API_KEY` | A Bedrock API key, sent as a bearer token. |

All four credential fields show as optional in the form; which ones are required depends on **Auth mode** and is
checked when you save.

### Auth modes

- **`ACCESS_KEYS`**: SigV4 with the access key id and secret (and session token if given).
- **`IAM_ROLE`**: the AWS default Node credential chain (`fromNodeProviderChain`): ECS task role, EC2 instance
  profile, IRSA, SSO profile or `AWS_*` environment variables of the api and worker. No credentials are stored in
  OCSO.
- **`API_KEY`**: a Bedrock API key as `Authorization: Bearer`.

In `ACCESS_KEYS` and `IAM_ROLE` modes OCSO pins SigV4, so an ambient `AWS_BEARER_TOKEN_BEDROCK` environment variable
cannot silently override the configured credentials.

## Steps

1. **Integrations → Models**, then **Configure** on the **AWS Bedrock** card.
2. Enter a **Name**, the **Region** (in the settings or the record), and the **Data residency zone** you want the
   policy to see (for example `IN` for `ap-south-1`).
3. Choose **Auth mode** and fill in the matching credentials.
4. Set **Health model** to a model id you have access to, for example an inference profile such as
   `apac.anthropic.claude-…` or a model id such as `amazon.nova-…`.
5. **Add provider (draft)**, **Test**, then **Enable** and have a second person approve it.

## Model ids

Use a foundation-model id (`anthropic.claude-…`, `amazon.nova-…`), a system-defined cross-region inference profile id
(`us.`, `eu.`, `apac.`, `global.` prefixes), or an application inference-profile ARN. Many newer models are only
callable through an inference profile.

Pricing: region prefixes are kept as they are, because the catalogs price them separately. Application
inference-profile ARNs say nothing about the model, so they are never priced from the catalog; add a manual price.

## Prompt caching

Card summary: **cachePoint breakpoints (Claude, Nova)**.

- **Claude and Nova**: with **Prefix cache**, OCSO adds `cachePoint` blocks at the compiler's breakpoints (at most
  4). A system cache point also covers tool definitions. **Cache TTL** **1 hour** is sent only for Claude 4.5 and
  later; older Claude and Nova get the 5-minute TTL.
- **Other models** (Llama, Mistral, DeepSeek, gpt-oss…): no cache points are ever sent.
- Tools are always resent: Bedrock strips tool history from a request that has no tools, which would change the
  prefix.
- Cache read and write counts are recorded only when Converse reports them.

## Model discovery

OCSO calls `https://bedrock.<region>.amazonaws.com`:

- `GET /foundation-models?byOutputModality=TEXT`, keeping models that output and accept text, are not embedding
  models, and support `ON_DEMAND` invocation.
- `GET /inference-profiles` (paged), keeping active profiles whose underlying model is a listed text model.
  System-defined profiles are listed by id, application profiles by ARN.

Input kinds come from the documented `inputModalities`.

## Capabilities OCSO assumes

By id family ([bedrock/models.ts](../../../packages/model-providers/src/providers/bedrock/models.ts)): Claude as on
[Anthropic](anthropic.md#capabilities-ocso-assumes); Nova with image and file input, tools, structured output and
explicit caching; everything else text-only with tool calling and no caching. Use **Capability overrides** when a
model does more.

## Verify it works

- **Test** passes against your **Health model**.
- The model picker lists foundation models and inference profiles for the region (if the List permissions exist).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `A Bedrock region is required` on save | Neither **Region** setting nor the record's region is set. |
| `An AWS access key id and secret access key are required` | **Auth mode** is `ACCESS_KEYS` but a key field is empty. |
| Access denied on test | Model access not granted in that region, or the identity lacks `bedrock:InvokeModel*` on that ARN. |
| Model picker error, test passes | The identity lacks `bedrock:ListFoundationModels` / `ListInferenceProfiles`. Type the id. |
| "on-demand throughput isn't supported" | The model needs an inference profile id instead of the bare model id. |

## Limits and known gaps

- Listing never verified against a live account (see the warning above).
- No InvokeModel path: Bedrock is always called through Converse.
- Data-residency, batch and provisioned-throughput pricing is not modelled.

## Related

- [Model providers overview](README.md)
- [Profiles, fallbacks and pricing](profiles-and-pricing.md)
- [Deploy on AWS](../deploy/aws.md)
