# Channels and Multimodal Interactions

## 1. Canonical interaction model

Channels must translate into a channel-neutral OCSO interaction.

```ts
type InteractionPart =
  | TextPart
  | ImagePart
  | AudioPart
  | VideoPart
  | DocumentPart
  | LocationPart
  | ContactPart
  | StructuredPart;
```

One interaction may contain many parts.

## 2. Channel adapter responsibilities

A `ChannelAdapter` owns:
- webhook/request verification
- external identity extraction
- inbound normalization
- media retrieval/reference handling
- deduplication/idempotency keys
- outbound rendering
- delivery acknowledgements/status
- channel capability declaration
- channel-specific limits

It does not own the agent loop.

## 3. WhatsApp

WhatsApp is a first-class initial channel.

Inbound requests arrive from the configured WhatsApp integration. The adapter must:
- verify authenticity
- map sender identity to `CustomerIdentity`
- persist inbound interactions before processing
- handle media safely
- avoid exposing tool/internal events to the customer
- support delivery status callbacks where applicable

## 4. Web chat

Web chat should use Vercel Chat SDK where it provides useful transport/UI primitives, but preserve OCSO's canonical event model.

The CS workspace is separate from customer web chat even if both are Next.js surfaces.

## 5. Rendering policy

Agent runtime emits a rich internal event stream.

Each channel renderer decides what can be shown:
- customer text
- media
- structured cards where supported
- citations where appropriate

Internal-only events such as raw tool traces, secrets, policy metadata or hidden agent state must not leak to customer channels.

## 6. Multimodal storage

Store:
- metadata and references in PostgreSQL
- larger binary payloads in S3-compatible blob storage

Apply:
- MIME/type validation
- size limits
- signed access
- malware/content safety hooks where required
- retention policy

## 7. Future voice

Voice should be implemented as another channel adapter plus streaming media capabilities, not by rewriting the core conversation model.

## Implementation notes (as built)

- Web chat is built on AI SDK UI (`useChat` with an OCSO transport over the public web chat API) inside an iframe served at `/chat/<channel key>` and embedded with `<script src="…/ocso-webchat.js" data-key="…">`; Chat SDK is deferred (ADR-007). The page's CSP `frame-ancestors` and the API's Origin check come from the channel's `allowedOrigins`.
- Channel kinds describe their settings (JSON Schema) and secrets for the admin form (`GET /v1/channels/kinds`); secrets are write-only.
- Media: inbound bytes are fetched by the worker (WhatsApp: allowlisted Meta hosts only, redirects re-checked), size/MIME-checked and stored in the blob store; staff reply attachments are uploaded per conversation and replies may only reference those keys. Retention can expire stored bytes (status `EXPIRED`, docs/15 notes).
