-- The audit outbox (PM/research/11 §6.2, ADR-032). audit_events keeps being written in the
-- same transaction as each change; the worker ships rows to the audit store (a separate
-- database) and reconciles them. Hand-written to match packages/db/src/schema/audit.ts
-- and settings.ts; never generated.
ALTER TABLE "audit_events" ADD COLUMN "team_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "shipped_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "verified_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "audit_events_unshipped_idx" ON "audit_events" USING btree ("occurred_at","id") WHERE "audit_events"."shipped_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "audit_events_unverified_idx" ON "audit_events" USING btree ("shipped_at") WHERE "audit_events"."shipped_at" IS NOT NULL AND "audit_events"."verified_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "audit_events_team_ids_idx" ON "audit_events" USING gin ("team_ids");
--> statement-breakpoint
CREATE TABLE "audit_incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "audit_incidents_kind_ck" CHECK ("audit_incidents"."kind" IN ('SHIP_FAILED', 'STORE_DOWN', 'RECONCILE_MISSING', 'CHAIN_BROKEN', 'EXPORT_FAILED', 'SIGNING_KEY_CHANGED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audit_incidents_open_uq" ON "audit_incidents" USING btree ("kind") WHERE "audit_incidents"."resolved_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "audit_incidents_seen_idx" ON "audit_incidents" USING btree ("last_seen");
--> statement-breakpoint
CREATE TABLE "audit_exports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"from_position" bigint NOT NULL,
	"to_position" bigint NOT NULL,
	"records" integer NOT NULL,
	"blob_key" text NOT NULL,
	"manifest_key" text NOT NULL,
	"sha256" text NOT NULL,
	"checkpoint_id" uuid NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_exports_range_ck" CHECK ("audit_exports"."to_position" >= "audit_exports"."from_position")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audit_exports_range_uq" ON "audit_exports" USING btree ("from_position");
--> statement-breakpoint
CREATE TABLE "audit_verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"head_at_start" bigint NOT NULL,
	"checked_to" bigint DEFAULT 0 NOT NULL,
	"entries" bigint DEFAULT 0 NOT NULL,
	"ok" boolean DEFAULT true NOT NULL,
	"problems" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_verifications_started_idx" ON "audit_verifications" USING btree ("started_at");
--> statement-breakpoint
ALTER TABLE "deployment_settings" ADD COLUMN "audit_local_window_days" integer DEFAULT 90 NOT NULL;
--> statement-breakpoint
ALTER TABLE "deployment_settings" ADD CONSTRAINT "deployment_settings_audit_window_ck" CHECK ("deployment_settings"."audit_local_window_days" >= 90 AND "deployment_settings"."audit_local_window_days" <= 3650);
--> statement-breakpoint
-- audit_events stays append-only. The only mutations the trigger now permits:
--   * UPDATE that changes nothing but shipped_at / verified_at (the shipper and reconciler),
--     never leaving a row verified without being shipped (verified_at requires shipped_at);
--   * DELETE under the retention cutoff the transaction declares (≥ 365 days, as since 0010);
--   * DELETE of a row the audit store verified (verified_at set) that is older than 90 days,
--     when the transaction sets ocso.audit_local_prune = 'on' (the local window prune).
-- TRUNCATE is always refused.
CREATE OR REPLACE FUNCTION ocso_reject_audit_mutation() RETURNS trigger AS $$
DECLARE
  cutoff text := current_setting('ocso.audit_retention_cutoff', true);
  prune text := current_setting('ocso.audit_local_prune', true);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'shipped_at' - 'verified_at') = (to_jsonb(OLD) - 'shipped_at' - 'verified_at')
       AND (NEW.verified_at IS NULL OR NEW.shipped_at IS NOT NULL)
       AND (NEW.verified_at IS NULL OR OLD.verified_at IS NOT NULL OR OLD.shipped_at IS NOT NULL) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF cutoff IS NOT NULL AND cutoff <> ''
       AND cutoff::timestamptz <= now() - interval '365 days'
       AND OLD.occurred_at < cutoff::timestamptz THEN
      RETURN OLD;
    END IF;
    IF prune = 'on' AND OLD.verified_at IS NOT NULL AND OLD.occurred_at < now() - interval '90 days' THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- Backfill team_ids for existing rows: the target's teams (the same rules as auditTeams() in
-- packages/application/src/audit/audit-teams.ts) ∪ the owning teams of an AGENT actor. A user
-- actor's teams are NOT backfilled: only their current membership is known, and a user who
-- moved teams would expose old actions to their new team (the actor still sees their own rows;
-- new rows carry the actor's teams at write time). Ids are cast once, guarded by a uuid check
-- in a CASE (evaluation order is guaranteed there), so every lookup uses a primary key or
-- foreign-key index. One UPDATE rewrites every audit row: expect minutes per million rows on
-- large installs, and run VACUUM (ANALYZE) audit_events afterwards (docs/archive/specs/15 §7).
-- The trigger is off for this one statement: it would (rightly) refuse any other UPDATE.
ALTER TABLE "audit_events" DISABLE TRIGGER "audit_events_immutable";
--> statement-breakpoint
WITH ids AS (
  SELECT e.id, e.target_type, e.actor_type,
         CASE WHEN e.target_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN e.target_id::uuid END AS tid,
         CASE WHEN e.actor_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN e.actor_id::uuid END AS aid
    FROM audit_events e
),
resolved AS (
  SELECT e.id, array_agg(DISTINCT t.team_id ORDER BY t.team_id) AS team_ids
    FROM ids e
    JOIN LATERAL (
      SELECT at.team_id FROM agent_teams at WHERE e.actor_type = 'AGENT' AND at.agent_id = e.aid
      UNION SELECT at.team_id FROM agent_teams at WHERE e.target_type = 'agent' AND at.agent_id = e.tid
      UNION SELECT at.team_id FROM prompt_versions x JOIN agent_teams at ON at.agent_id = x.agent_id WHERE e.target_type = 'prompt_version' AND x.id = e.tid
      UNION SELECT at.team_id FROM escalation_rules x JOIN agent_teams at ON at.agent_id = x.agent_id WHERE e.target_type = 'escalation_rule' AND x.id = e.tid
      UNION SELECT at.team_id FROM prompt_corrections x JOIN agent_teams at ON at.agent_id = x.agent_id WHERE e.target_type = 'prompt_correction' AND x.id = e.tid
      UNION SELECT at.team_id FROM evaluation_runs x JOIN agent_teams at ON at.agent_id = x.agent_id WHERE e.target_type = 'evaluation_run' AND x.id = e.tid
      UNION SELECT at.team_id FROM alert_rules x JOIN agent_teams at ON at.agent_id = x.agent_id WHERE e.target_type = 'alert_rule' AND x.id = e.tid
      UNION SELECT at.team_id FROM conversations x JOIN agent_teams at ON at.agent_id = x.agent_id WHERE e.target_type = 'conversation' AND x.id = e.tid
      UNION SELECT qt.team_id FROM conversations x JOIN queue_teams qt ON qt.queue_id = x.queue_id WHERE e.target_type = 'conversation' AND x.id = e.tid
      UNION SELECT at.team_id FROM tool_calls tc JOIN conversations x ON x.id = tc.conversation_id JOIN agent_teams at ON at.agent_id = x.agent_id WHERE e.target_type = 'tool_call' AND tc.id = e.tid
      UNION SELECT qt.team_id FROM tool_calls tc JOIN conversations x ON x.id = tc.conversation_id JOIN queue_teams qt ON qt.queue_id = x.queue_id WHERE e.target_type = 'tool_call' AND tc.id = e.tid
      UNION SELECT tm.team_id FROM team_members tm WHERE e.target_type = 'user' AND tm.user_id = e.tid
      UNION SELECT t.id FROM teams t WHERE e.target_type = 'team' AND t.id = e.tid
      UNION SELECT qt.team_id FROM queue_teams qt WHERE e.target_type = 'queue' AND qt.queue_id = e.tid
      UNION SELECT unnest(p.team_ids) FROM approval_proposals p WHERE e.target_type = 'approval' AND p.id = e.tid
    ) t(team_id) ON true
   WHERE e.tid IS NOT NULL OR e.aid IS NOT NULL
   GROUP BY e.id
)
UPDATE audit_events e SET team_ids = resolved.team_ids FROM resolved WHERE resolved.id = e.id AND resolved.team_ids <> '{}'::uuid[];
--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE TRIGGER "audit_events_immutable";
