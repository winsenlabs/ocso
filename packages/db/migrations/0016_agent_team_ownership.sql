CREATE TABLE "agent_teams" (
	"agent_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_teams_agent_id_team_id_pk" PRIMARY KEY("agent_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "agent_teams" ADD CONSTRAINT "agent_teams_agent_id_virtual_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."virtual_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_teams" ADD CONSTRAINT "agent_teams_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_teams_team_idx" ON "agent_teams" USING btree ("team_id");--> statement-breakpoint
-- ADR-026 backfill: an existing agent is owned by the teams that serve its default queue.
-- Agents without a default queue (or whose queue has no team) stay unowned: Tech Admin only until assigned.
INSERT INTO "agent_teams" ("agent_id", "team_id")
SELECT "virtual_agents"."id", "queue_teams"."team_id"
FROM "virtual_agents"
INNER JOIN "queue_teams" ON "queue_teams"."queue_id" = "virtual_agents"."default_queue_id"
ON CONFLICT DO NOTHING;
