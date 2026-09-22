CREATE TABLE "whatsapp_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"provider_template_id" text NOT NULL,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"category" text NOT NULL,
	"status" text NOT NULL,
	"rejection_reason" text,
	"definition" jsonb NOT NULL,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_checked_at" timestamp with time zone,
	"status_changed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_templates_provider_uq" ON "whatsapp_templates" USING btree ("channel_id","provider_template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_templates_name_uq" ON "whatsapp_templates" USING btree ("channel_id","name","language") WHERE "whatsapp_templates"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "whatsapp_templates_pending_idx" ON "whatsapp_templates" USING btree ("status") WHERE "whatsapp_templates"."status" = 'PENDING' AND "whatsapp_templates"."deleted_at" IS NULL;