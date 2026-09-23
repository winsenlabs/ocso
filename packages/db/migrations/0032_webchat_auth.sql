-- 0032_webchat_auth (plugins release, SPEC §C). Hand-written; never run drizzle-kit generate.
-- Web chat auth, host context and tool identity:
--   * conversations.host_context: the context the embedding site passed with the visitor's latest session
--     ({ source: 'host'|'client', values: {...}, at }); 'host' = vouched by the site's backend (session pass or
--     verified user token), 'client' = sent by the browser, shown to the agent as unverified.
--   * webchat_user_tokens: a verified end-user token kept (AES-256-GCM, key derived from the channel's secret key)
--     only for channels whose tool identity is 'passthrough', until the token's own exp (at most 24 h).
--   * webchat_session_pass_uses: single-use record of session-pass ids (jti) until the pass expires.
--   * mcp_connections.forward_user_token: the connection receives that user token on agent tool calls
--     (part of the connection's approvable policy).
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "host_context" jsonb;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webchat_user_tokens" (
  "id" uuid PRIMARY KEY NOT NULL,
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "visitor_id" text,
  "token_ciphertext" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webchat_user_tokens_customer_idx" ON "webchat_user_tokens" USING btree ("customer_id", "channel_id", "expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webchat_user_tokens_expires_idx" ON "webchat_user_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webchat_session_pass_uses" (
  "jti" text PRIMARY KEY NOT NULL,
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "expires_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webchat_session_pass_uses_expires_idx" ON "webchat_session_pass_uses" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN IF NOT EXISTS "forward_user_token" boolean DEFAULT false NOT NULL;
