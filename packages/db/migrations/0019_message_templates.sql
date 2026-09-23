-- Message templates are a channel capability, not a WhatsApp feature (plugin boundary, ADR-028):
-- rename the table and every name derived from it. Rows, ids and data are unchanged.
ALTER TABLE "whatsapp_templates" RENAME TO "message_templates";--> statement-breakpoint
ALTER TABLE "message_templates" RENAME CONSTRAINT "whatsapp_templates_pkey" TO "message_templates_pkey";--> statement-breakpoint
ALTER TABLE "message_templates" RENAME CONSTRAINT "whatsapp_templates_channel_id_channels_id_fk" TO "message_templates_channel_id_channels_id_fk";--> statement-breakpoint
ALTER TABLE "message_templates" RENAME CONSTRAINT "whatsapp_templates_submitted_by_users_id_fk" TO "message_templates_submitted_by_users_id_fk";--> statement-breakpoint
ALTER INDEX "whatsapp_templates_provider_uq" RENAME TO "message_templates_provider_uq";--> statement-breakpoint
ALTER INDEX "whatsapp_templates_name_uq" RENAME TO "message_templates_name_uq";--> statement-breakpoint
ALTER INDEX "whatsapp_templates_pending_idx" RENAME TO "message_templates_pending_idx";
