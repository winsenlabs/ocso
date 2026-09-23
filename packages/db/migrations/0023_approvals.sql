-- Maker–checker (PM/research/11 §4, 11b): proposals, the append-only decision history, and the
-- approval age threshold. Hand-written to match packages/db/src/schema/approvals.ts and settings.ts.
CREATE TABLE "approval_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"object_kind" text NOT NULL,
	"object_id" uuid NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'SUBMITTED' NOT NULL,
	"origin" text DEFAULT 'USER' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb,
	"content_hash" text NOT NULL,
	"dependency_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"dependency_hash" text NOT NULL,
	"team_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"title" text NOT NULL,
	"reason" text NOT NULL,
	"maker_id" uuid,
	"checker_id" uuid,
	"checker_valid" boolean DEFAULT true NOT NULL,
	"edited_after_submission" boolean DEFAULT false NOT NULL,
	"bootstrap" boolean DEFAULT false NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"decision_reason" text,
	"activated_at" timestamp with time zone,
	"activation_attempts" integer DEFAULT 0 NOT NULL,
	"blocked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_proposals_action_ck" CHECK ("approval_proposals"."action" IN ('CREATE','UPDATE','DELETE','ACTIVATE')),
	CONSTRAINT "approval_proposals_status_ck" CHECK ("approval_proposals"."status" IN ('SUBMITTED','APPROVED','REJECTED','WITHDRAWN','BLOCKED','VOID')),
	CONSTRAINT "approval_proposals_self_ck" CHECK ("approval_proposals"."maker_id" IS NULL OR "approval_proposals"."checker_id" IS NULL OR "approval_proposals"."maker_id" <> "approval_proposals"."checker_id" OR "approval_proposals"."bootstrap"),
	CONSTRAINT "approval_proposals_open_ck" CHECK ("approval_proposals"."status" <> 'SUBMITTED' OR ("approval_proposals"."maker_id" IS NOT NULL AND "approval_proposals"."checker_id" IS NOT NULL)),
	CONSTRAINT "approval_proposals_decider_ck" CHECK ("approval_proposals"."decided_by" IS NULL OR "approval_proposals"."maker_id" IS NULL OR "approval_proposals"."decided_by" <> "approval_proposals"."maker_id" OR "approval_proposals"."bootstrap" OR "approval_proposals"."status" IN ('WITHDRAWN','VOID'))
);
--> statement-breakpoint
CREATE TABLE "approval_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"proposal_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"kind" text NOT NULL,
	"actor_id" uuid,
	"actor_name" text NOT NULL,
	"reason" text,
	"content_hash" text NOT NULL,
	"diff" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bulk_batch_id" uuid,
	"audit_event_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_decisions_kind_ck" CHECK ("approval_decisions"."kind" IN ('SUBMIT','EDIT','APPROVE','BOOTSTRAP_APPROVE','REJECT','WITHDRAW','REASSIGN','BLOCK','VOID','ACTIVATE'))
);
--> statement-breakpoint
ALTER TABLE "approval_proposals" ADD CONSTRAINT "approval_proposals_maker_id_users_id_fk" FOREIGN KEY ("maker_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_proposals" ADD CONSTRAINT "approval_proposals_checker_id_users_id_fk" FOREIGN KEY ("checker_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_proposals" ADD CONSTRAINT "approval_proposals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_proposal_id_approval_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."approval_proposals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_proposals_open_uq" ON "approval_proposals" USING btree ("object_kind","object_id") WHERE "approval_proposals"."status" = 'SUBMITTED';--> statement-breakpoint
CREATE INDEX "approval_proposals_checker_idx" ON "approval_proposals" USING btree ("checker_id","status","submitted_at");--> statement-breakpoint
CREATE INDEX "approval_proposals_maker_idx" ON "approval_proposals" USING btree ("maker_id","submitted_at");--> statement-breakpoint
CREATE INDEX "approval_proposals_open_idx" ON "approval_proposals" USING btree ("submitted_at") WHERE "approval_proposals"."status" = 'SUBMITTED';--> statement-breakpoint
CREATE INDEX "approval_proposals_object_idx" ON "approval_proposals" USING btree ("object_kind","object_id","submitted_at");--> statement-breakpoint
CREATE INDEX "approval_proposals_page_idx" ON "approval_proposals" USING btree ("submitted_at","id");--> statement-breakpoint
CREATE INDEX "approval_proposals_teams_idx" ON "approval_proposals" USING gin ("team_ids");--> statement-breakpoint
CREATE INDEX "approval_proposals_activate_idx" ON "approval_proposals" USING btree ("status") WHERE "approval_proposals"."status" = 'APPROVED' AND "approval_proposals"."activated_at" IS NULL;--> statement-breakpoint
CREATE INDEX "approval_decisions_proposal_idx" ON "approval_decisions" USING btree ("proposal_id","occurred_at");--> statement-breakpoint
CREATE INDEX "approval_decisions_kind_idx" ON "approval_decisions" USING btree ("kind","occurred_at");--> statement-breakpoint
CREATE INDEX "approval_decisions_bulk_idx" ON "approval_decisions" USING btree ("bulk_batch_id") WHERE "approval_decisions"."bulk_batch_id" IS NOT NULL;--> statement-breakpoint

-- The decision history is append-only, like audit_events, with its own function (ocso_reject_audit_mutation is not touched).
CREATE OR REPLACE FUNCTION ocso_reject_decision_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'approval_decisions is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER approval_decisions_immutable
  BEFORE UPDATE OR DELETE ON approval_decisions
  FOR EACH ROW EXECUTE FUNCTION ocso_reject_decision_mutation();
--> statement-breakpoint
CREATE TRIGGER approval_decisions_no_truncate
  BEFORE TRUNCATE ON approval_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION ocso_reject_decision_mutation();
--> statement-breakpoint
ALTER TABLE "deployment_settings" ADD COLUMN "approval_age_warning_hours" integer DEFAULT 72 NOT NULL;
--> statement-breakpoint

-- A proposal is the approval record: once decided it is frozen (bank audit: an approval state that can be
-- edited after the decision is no approval). Rows are never deleted. New rows start SUBMITTED (grandfathered
-- MIGRATION rows excepted). While SUBMITTED the spine edits, reassigns, flags and decides it; the identity of
-- the change (maker, object, action, origin) never changes. After the decision only these remain:
-- APPROVED -> BLOCKED while not yet activated (deferred activation failed), stamping activated_at once,
-- counting activation_attempts, stamping notified_at, and updated_at.
CREATE OR REPLACE FUNCTION ocso_guard_approval_proposal() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'approval_proposals rows are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'SUBMITTED' AND NEW.origin <> 'MIGRATION' THEN
      RAISE EXCEPTION 'a proposal is created SUBMITTED' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.maker_id IS DISTINCT FROM OLD.maker_id
     OR NEW.object_kind IS DISTINCT FROM OLD.object_kind
     OR NEW.object_id IS DISTINCT FROM OLD.object_id
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'the maker, object and action of a proposal never change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'SUBMITTED' THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'APPROVED' AND NEW.status = 'BLOCKED' AND OLD.activated_at IS NULL) THEN
    RAISE EXCEPTION 'a decided proposal cannot change status (% -> %)', OLD.status, NEW.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
    RAISE EXCEPTION 'activated_at is stamped once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.blocked_reason IS DISTINCT FROM OLD.blocked_reason AND NOT (NEW.status = 'BLOCKED' AND OLD.status = 'APPROVED') THEN
    RAISE EXCEPTION 'a decided proposal is frozen' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.before_snapshot IS DISTINCT FROM OLD.before_snapshot
     OR NEW.after_snapshot IS DISTINCT FROM OLD.after_snapshot
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.dependency_keys IS DISTINCT FROM OLD.dependency_keys
     OR NEW.dependency_hash IS DISTINCT FROM OLD.dependency_hash
     OR NEW.team_ids IS DISTINCT FROM OLD.team_ids
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.checker_id IS DISTINCT FROM OLD.checker_id
     OR NEW.checker_valid IS DISTINCT FROM OLD.checker_valid
     OR NEW.edited_after_submission IS DISTINCT FROM OLD.edited_after_submission
     OR NEW.bootstrap IS DISTINCT FROM OLD.bootstrap
     OR NEW.warnings IS DISTINCT FROM OLD.warnings
     OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
     OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
     OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason THEN
    RAISE EXCEPTION 'a decided proposal is frozen' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER approval_proposals_guard
  BEFORE INSERT OR UPDATE OR DELETE ON approval_proposals
  FOR EACH ROW EXECUTE FUNCTION ocso_guard_approval_proposal();
--> statement-breakpoint
CREATE TRIGGER approval_proposals_no_truncate
  BEFORE TRUNCATE ON approval_proposals
  FOR EACH STATEMENT EXECUTE FUNCTION ocso_guard_approval_proposal();
--> statement-breakpoint

-- Prompt versions stay immutable. The one exception: an approved DELETE of their agent (which never served a
-- conversation) removes them with it — the trigger checks for that APPROVED, user-made DELETE proposal itself
-- (proposals are frozen once decided, above), rather than trusting anything the session says. Same UPDATE
-- rules as 0001.
CREATE OR REPLACE FUNCTION ocso_guard_prompt_version() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM approval_proposals
       WHERE object_kind = 'agent' AND object_id = OLD.agent_id AND action = 'DELETE'
         AND status = 'APPROVED' AND origin = 'USER'
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'prompt_versions are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.components IS DISTINCT FROM OLD.components
     OR NEW.prompt_hash IS DISTINCT FROM OLD.prompt_hash
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.author_id IS DISTINCT FROM OLD.author_id THEN
    RAISE EXCEPTION 'prompt_versions are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
