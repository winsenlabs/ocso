-- Ask OCSO as a copilot (PM/research/12): every write the agent proposes is a server-built confirmation card.
-- `card` holds the card as the drawer shows it (title, object, before → after, warnings, approval checkers);
-- `card_hash` binds it to (tool, arguments, object state) so a confirm is refused (STALE) when the object changed;
-- `call_id` is the model's tool call; `proposal_id` is the approval proposal a governed card submitted.
-- Statuses gain SUBMITTED (sent to a checker), STALE and CONFIRMING (the single-use claim while it runs).
-- Rows written before this release keep a null card and are shown in their earlier shape.
ALTER TABLE "internal_agent_actions" ADD COLUMN "card" jsonb;--> statement-breakpoint
ALTER TABLE "internal_agent_actions" ADD COLUMN "card_hash" text;--> statement-breakpoint
ALTER TABLE "internal_agent_actions" ADD COLUMN "call_id" text;--> statement-breakpoint
ALTER TABLE "internal_agent_actions" ADD COLUMN "proposal_id" uuid;--> statement-breakpoint
CREATE INDEX "internal_agent_actions_thread_idx" ON "internal_agent_actions" USING btree ("thread_id");--> statement-breakpoint
-- The Ask OCSO writes kill switch (§9): off → the agent still reads, but builds and confirms no cards. A governed
-- deployment setting (the settings approval's deployment section), on by default.
ALTER TABLE "deployment_settings" ADD COLUMN "ask_ocso_writes" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Approval history names the channel a decision came through (PM/research/12 §5: "submitted via Ask OCSO"):
-- INTERNAL_AGENT when Ask OCSO ran the route for the user, null for the UI and API. Existing rows stay null.
ALTER TABLE "approval_decisions" ADD COLUMN "via" text;
