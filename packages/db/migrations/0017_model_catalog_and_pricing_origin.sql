CREATE TABLE "model_catalog_snapshots" (
	"source" text PRIMARY KEY NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"content_hash" text NOT NULL,
	"entry_count" integer NOT NULL,
	"entries" jsonb NOT NULL,
	"last_attempt_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_pricing" ADD COLUMN "tiers" jsonb;--> statement-breakpoint
ALTER TABLE "model_pricing" ADD COLUMN "origin" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_pricing" ADD COLUMN "catalog_source" text;--> statement-breakpoint
ALTER TABLE "model_pricing" ADD COLUMN "catalog_provider" text;--> statement-breakpoint
ALTER TABLE "model_pricing" ADD COLUMN "catalog_model_id" text;--> statement-breakpoint
ALTER TABLE "model_pricing" ADD COLUMN "catalog_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_pricing" ADD COLUMN "updated_at" timestamp with time zone;