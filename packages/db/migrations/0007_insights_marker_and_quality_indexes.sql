ALTER TABLE "conversations" ADD COLUMN "insights_requested_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "conversation_reviews_conversation_idx" ON "conversation_reviews" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "csat_responses_conversation_idx" ON "csat_responses" USING btree ("conversation_id","received_at");--> statement-breakpoint
CREATE INDEX "evaluation_runs_agent_idx" ON "evaluation_runs" USING btree ("agent_id","created_at");