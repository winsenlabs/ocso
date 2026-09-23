-- Maker–checker coverage of platform objects (PM/research/11 §4, wave 2 COVERAGE-PLATFORM). Hand-written to
-- match packages/db/src/schema/models.ts and auth.ts. Approval itself stays derived from approval_proposals;
-- these columns only give two kinds an inert draft state the runtime can see:
-- * model_pricing.status: a price row a person enters is a DRAFT (never used for cost) until approved. Existing
--   rows and the system's catalog rows are ACTIVE (the default), so nothing changes for them.
-- * auth_sso_providers.status: a newly registered identity provider is a DRAFT (sign-in through it is refused)
--   until approved; DISABLED is the immediate stop. Existing providers stay ACTIVE; Better Auth inserts rows
--   without this column, so new rows take the DRAFT default.
ALTER TABLE "model_pricing" ADD COLUMN "status" text DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_pricing" ADD CONSTRAINT "model_pricing_status_ck" CHECK ("model_pricing"."status" IN ('DRAFT', 'ACTIVE'));--> statement-breakpoint
ALTER TABLE "auth_sso_providers" ADD COLUMN "status" text DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_sso_providers" ALTER COLUMN "status" SET DEFAULT 'DRAFT';--> statement-breakpoint
ALTER TABLE "auth_sso_providers" ADD CONSTRAINT "auth_sso_providers_status_ck" CHECK ("auth_sso_providers"."status" IN ('DRAFT', 'ACTIVE', 'DISABLED'));--> statement-breakpoint
-- The secret refs maker–checker owns (schema/approval-secrets.ts): STAGED values a proposal may carry, and
-- RELEASED refs an approved change stopped using, deleted from the SecretStore only after that commits.
CREATE TABLE "approval_secret_refs" (
	"ref" text PRIMARY KEY NOT NULL,
	"object_kind" text NOT NULL,
	"object_id" uuid NOT NULL,
	"maker_id" uuid,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_secret_refs_state_ck" CHECK ("approval_secret_refs"."state" IN ('STAGED', 'RELEASED'))
);--> statement-breakpoint
CREATE INDEX "approval_secret_refs_object_idx" ON "approval_secret_refs" USING btree ("object_kind","object_id");--> statement-breakpoint
CREATE INDEX "approval_secret_refs_state_idx" ON "approval_secret_refs" USING btree ("state","created_at");
