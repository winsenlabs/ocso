-- Ask OCSO over staff chat channels (Slack, Microsoft Teams, any kind whose descriptor sets staffDestination):
-- a staff member links their chat account to their OCSO user once, by signing in to OCSO, and then asks Ask OCSO
-- from chat as themselves.
--
-- channel_account_links: one chat identity (the channel adapter's identity kind + value) on one channel, linked to
-- one OCSO user. At most one ACTIVE link per chat identity per channel; a revoked link stays for the record.
-- `auth_method` is how the linking session was signed in (the MFA policy is checked against it on every message);
-- `profile_name` is the chat display name the provider sent, for the account page.
CREATE TABLE "channel_account_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"identity_kind" text NOT NULL,
	"identity_value" text NOT NULL,
	"profile_name" text,
	"user_id" uuid NOT NULL,
	"auth_method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "channel_account_links" ADD CONSTRAINT "channel_account_links_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_account_links" ADD CONSTRAINT "channel_account_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_account_links_active_uq" ON "channel_account_links" USING btree ("channel_id","identity_kind","identity_value") WHERE "channel_account_links"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "channel_account_links_user_idx" ON "channel_account_links" USING btree ("user_id","created_at");--> statement-breakpoint
-- channel_link_tokens: the one-time link OCSO sends an unknown sender ("Link your account: …/link/<token>"). Only the
-- sha256 of the token is stored; it is bound to the channel and chat identity, expires after 10 minutes and is used once.
-- `reply_context` is where "Linked." is posted back (the adapter's opaque InboundMessage.replyContext).
-- Confirming on the link page only claims the token (`claimed_by`) and shows the user a short code (only its sha256 is
-- kept in `claim_code_hash`); the link is made when that code is sent back from the same chat identity, so an OCSO
-- user cannot be talked into linking someone else's chat account. `claim_attempts` counts wrong codes.
CREATE TABLE "channel_link_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"identity_kind" text NOT NULL,
	"identity_value" text NOT NULL,
	"profile_name" text,
	"reply_context" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"claimed_by" uuid,
	"claim_code_hash" text,
	"claim_auth_method" text,
	"claim_attempts" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
ALTER TABLE "channel_link_tokens" ADD CONSTRAINT "channel_link_tokens_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_link_tokens" ADD CONSTRAINT "channel_link_tokens_claimed_by_users_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_link_tokens_identity_idx" ON "channel_link_tokens" USING btree ("channel_id","identity_kind","identity_value","created_at");--> statement-breakpoint
-- channel_staff_messages: inbound messages of a staff (Ask OCSO) channel, kept only to take each provider message
-- once (providers retry) and to rate-limit a link. No message content is stored here.
CREATE TABLE "channel_staff_messages" (
	"channel_id" uuid NOT NULL,
	"external_message_id" text NOT NULL,
	"link_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_staff_messages_pk" PRIMARY KEY("channel_id","external_message_id")
);--> statement-breakpoint
ALTER TABLE "channel_staff_messages" ADD CONSTRAINT "channel_staff_messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_staff_messages" ADD CONSTRAINT "channel_staff_messages_link_id_channel_account_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."channel_account_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_staff_messages_link_idx" ON "channel_staff_messages" USING btree ("link_id","received_at");--> statement-breakpoint
CREATE INDEX "channel_staff_messages_received_idx" ON "channel_staff_messages" USING btree ("received_at");--> statement-breakpoint
-- Ask OCSO threads started from a linked chat account: which surface (the channel kind, lower case), which link, and
-- which chat thread (a digest of the adapter's reply context), so each chat thread continues its own Ask OCSO thread.
-- Null for drawer threads.
ALTER TABLE "internal_agent_threads" ADD COLUMN "surface" text;--> statement-breakpoint
ALTER TABLE "internal_agent_threads" ADD COLUMN "channel_link_id" uuid;--> statement-breakpoint
ALTER TABLE "internal_agent_threads" ADD COLUMN "chat_thread_key" text;--> statement-breakpoint
ALTER TABLE "internal_agent_threads" ADD CONSTRAINT "internal_agent_threads_channel_link_id_channel_account_links_id_fk" FOREIGN KEY ("channel_link_id") REFERENCES "public"."channel_account_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "internal_agent_threads_chat_uq" ON "internal_agent_threads" USING btree ("channel_link_id","chat_thread_key") WHERE "internal_agent_threads"."channel_link_id" IS NOT NULL;
