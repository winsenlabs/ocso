CREATE TABLE "worker_scaling_state" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"driver" text NOT NULL,
	"apply_status" text NOT NULL,
	"apply_message" text NOT NULL,
	"apply_detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"last_succeeded_at" timestamp with time zone,
	"settings_updated_at" timestamp with time zone NOT NULL,
	"deployment" jsonb,
	"described_at" timestamp with time zone,
	"describe_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_scaling_state_singleton_ck" CHECK ("worker_scaling_state"."id" = 1)
);
