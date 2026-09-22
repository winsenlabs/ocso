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
