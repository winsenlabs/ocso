ALTER TABLE "copilot_suggestions" ADD COLUMN "requested_by" uuid;--> statement-breakpoint
ALTER TABLE "copilot_suggestions" ADD COLUMN "style" text;--> statement-breakpoint
ALTER TABLE "copilot_suggestions" ADD COLUMN "basis" jsonb DEFAULT '{"historyMessages":0,"policyRefs":[]}'::jsonb NOT NULL;