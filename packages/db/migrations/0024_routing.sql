-- Routing (PM/research/11 §5.1): channel → router → queue → agent. Routers with immutable versions and one
-- editable draft; channels point at a router; a queue carries its one AI agent, attributes, hours and transfer
-- targets; a conversation may be ROUTING with no agent yet; turns record their agent. The unique index swap
-- and the data backfill are 0025.
CREATE TABLE "routers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"active_version_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routers_status_ck" CHECK ("routers"."status" IN ('DRAFT','ACTIVE','DISABLED'))
);
--> statement-breakpoint
ALTER TABLE "routers" ADD CONSTRAINT "routers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "routers_name_uq" ON "routers" USING btree (lower("name"));--> statement-breakpoint
CREATE TABLE "router_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"router_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "router_versions" ADD CONSTRAINT "router_versions_router_id_routers_id_fk" FOREIGN KEY ("router_id") REFERENCES "public"."routers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "router_versions" ADD CONSTRAINT "router_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "router_versions_router_version_uq" ON "router_versions" USING btree ("router_id","version");--> statement-breakpoint
-- Router versions are immutable (like prompt_versions): a change is a new version.
CREATE OR REPLACE FUNCTION ocso_guard_router_version() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A router's own deletion cascades; nothing else may remove a version.
    IF NOT EXISTS (SELECT 1 FROM routers WHERE id = OLD.router_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'router_versions are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RAISE EXCEPTION 'router_versions are immutable' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER router_versions_immutable
  BEFORE UPDATE OR DELETE ON router_versions
  FOR EACH ROW EXECUTE FUNCTION ocso_guard_router_version();
--> statement-breakpoint
CREATE TABLE "router_drafts" (
	"router_id" uuid PRIMARY KEY NOT NULL,
	"definition" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "router_drafts" ADD CONSTRAINT "router_drafts_router_id_routers_id_fk" FOREIGN KEY ("router_id") REFERENCES "public"."routers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "router_drafts" ADD CONSTRAINT "router_drafts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "router_id" uuid;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_router_id_routers_id_fk" FOREIGN KEY ("router_id") REFERENCES "public"."routers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queues" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "queues" ADD COLUMN "attributes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "queues" ADD COLUMN "business_hours" jsonb;--> statement-breakpoint
ALTER TABLE "queues" ADD COLUMN "transfer_target_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "queues" ADD CONSTRAINT "queues_agent_id_virtual_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."virtual_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "queues_attributes_uq" ON "queues" USING btree ("attributes") WHERE "queues"."attributes" <> '{}'::jsonb;--> statement-breakpoint
CREATE INDEX "queues_agent_idx" ON "queues" USING btree ("agent_id");--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_control_state_ck";--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_control_state_ck"
  CHECK (control_state IN ('AI_ACTIVE','ESCALATION_REQUESTED','WAITING_FOR_HUMAN','HUMAN_ACTIVE','AI_RESUMING','RESOLVED','ROUTING'));--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_or_routing_ck" CHECK ("conversations"."agent_id" IS NOT NULL OR "conversations"."control_state" IN ('ROUTING', 'RESOLVED'));--> statement-breakpoint
CREATE TABLE "conversation_routing" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"router_id" uuid,
	"router_version_id" uuid,
	"phase" text NOT NULL,
	"step_index" integer DEFAULT 0 NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"classifications" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"follow_ups" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"previous_state" text,
	"awaiting_since" timestamp with time zone,
	"seq_from" integer DEFAULT 0 NOT NULL,
	"outcome" text,
	"rule_index" integer,
	"queue_id" uuid,
	"decided_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_routing_phase_ck" CHECK ("conversation_routing"."phase" IN ('RETURNING','STEPS','DONE'))
);
--> statement-breakpoint
ALTER TABLE "conversation_routing" ADD CONSTRAINT "conversation_routing_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_routing" ADD CONSTRAINT "conversation_routing_router_id_routers_id_fk" FOREIGN KEY ("router_id") REFERENCES "public"."routers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_routing" ADD CONSTRAINT "conversation_routing_router_version_id_router_versions_id_fk" FOREIGN KEY ("router_version_id") REFERENCES "public"."router_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_routing" ADD CONSTRAINT "conversation_routing_queue_id_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_routing_awaiting_idx" ON "conversation_routing" USING btree ("awaiting_since") WHERE "conversation_routing"."phase" <> 'DONE' AND "conversation_routing"."awaiting_since" IS NOT NULL;
