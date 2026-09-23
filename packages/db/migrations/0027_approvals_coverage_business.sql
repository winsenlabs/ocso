-- PM/research/11 wave 2, COVERAGE-BUSINESS (hand-written; matches src/schema/message-templates.ts).
-- Message templates become maker–checker objects: a template is first saved in OCSO as a DRAFT that the provider
-- has never seen (no provider id yet), and only an approved proposal submits it. Agent tool grants, escalation
-- rules, alert rules, users and permission changes need no columns: approval state lives in approval_proposals.
ALTER TABLE "message_templates" ALTER COLUMN "provider_template_id" DROP NOT NULL;--> statement-breakpoint
-- OCSO: made here (drafted, then submitted through an approval). PROVIDER: created in the provider's console and
-- recorded only when someone asked OCSO to delete it (the delete proposal needs an object to point at).
ALTER TABLE "message_templates" ADD COLUMN "origin" text DEFAULT 'OCSO' NOT NULL;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_origin_ck" CHECK ("origin" IN ('OCSO', 'PROVIDER'));--> statement-breakpoint
-- Only a DRAFT can be missing its provider id, and a provider-made template always has one.
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_provider_id_ck" CHECK ("provider_template_id" IS NOT NULL OR ("status" = 'DRAFT' AND "origin" = 'OCSO'));
