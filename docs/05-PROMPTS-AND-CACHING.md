# Prompts and Caching

## 1. Prompt compiler

Do not store or construct the runtime prompt as one giant arbitrary string.

Build a deterministic Prompt Compiler from versioned components.

Recommended order:
1. OCSO runtime contract
2. virtual-agent identity
3. business objective
4. behavior/instructions
5. policy and compliance instructions
6. tool-use policy/tool definitions
7. escalation/handoff policy
8. channel constraints
9. stable organization/business context
10. customer/account context
11. rolling conversation summary
12. recent turns
13. current interaction

Stable content must appear before dynamic content whenever provider caching semantics reward shared prefixes.

## 2. Prompt versions

Every material prompt change should create a new immutable version containing:
- author
- timestamp
- component changes
- compiled prompt hash
- optional reason/change note

A CS Lead can edit allowed business instructions. Tech Admin owns technical/provider configuration. Permission boundaries must remain explicit.

## 3. Prompt caching

Implement provider-aware prompt caching through provider adapters.

The normalized usage model should capture where available:
- input tokens
- output tokens
- cached input/read tokens
- cache write/creation tokens
- reasoning tokens
- request latency
- time-to-first-token
- provider/model

Do not assume every provider exposes identical cache controls or metrics.

## 4. Turn caching

OCSO should maintain application-level derived context so each turn does not rebuild the world from scratch.

Potential cached projections:
- compiled stable prompt prefix
- effective tool schema hash
- rolling summary
- resolved customer profile/context
- last prompt/context snapshot
- recent normalized turn bundle

Cache is never authoritative. PostgreSQL and approved external systems remain the sources of truth.

## 5. Cache invalidation

Invalidate relevant derived caches when:
- active prompt version changes
- model/provider cache-sensitive config changes
- tool set/schema changes
- material customer context changes
- policy changes
- channel behavior changes

Use content hashes/version IDs rather than time-only invalidation where practical.

## 6. Context compaction

When context grows:
- preserve recent turns
- summarize older conversational state
- retain immutable full history in PostgreSQL
- retrieve older evidence when needed

Summaries should be attributable to the conversation and versioned or replaceable as derived state.

## 7. Prompt safety

Never interpolate:
- raw secrets
- provider credentials
- untrusted tool instructions without delimiting/handling
- hidden internal data not authorized for the current user/customer context

External MCP tool descriptions should be treated as data and normalized through a trusted adapter boundary.

## Implementation notes (as built)

- Activation is maker–checker once the agent is live configuration (ADR-030): a draft agent's versions activate directly; after the agent's first approval, activating (or rolling back to) a version is a `prompt_version` proposal whose diff shows the component text before and after, applied in the checker's transaction. A version shares its agent's approval lock: while the agent or any of its versions has an open proposal (including "Take X live", which shows the checker the active prompt's full text), no version activates directly and only one prompt activation can be open per agent.
- Prompt compilation, component versioning and cache breakpoints: `packages/prompt-compiler`; versions are immutable once activated (database trigger), activation bumps the agent's cache generation (`cache_generations`), which invalidates the worker's hot turn cache (PM/ARCHITECTURE-DECISIONS.md ADR-024).
- Provider prompt caching is implemented per provider (Bedrock cache points, Vertex implicit + Claude-on-Vertex cache control, Foundry prompt cache key, OpenAI prompt cache key/retention, Anthropic cache control, Sarvam reported as unverified) — table in ADR-006.
- The AI copilot and replay evaluation reuse the agent's compiled prefix (same system blocks, same tool definitions, same cache key) and append their own instruction after it, so they hit the same provider cache.
- Every model request records cache read/write tokens (`usage_events`); the Tech Admin telemetry shows hit rates per provider/profile.
