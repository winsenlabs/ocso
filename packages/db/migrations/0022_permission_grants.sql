-- Per-user permissions (PM/research/11 §3.3). Rights = preset ∪ active GRANTs − active REVOKEs.
-- Active = cleared_at IS NULL AND (expires_at IS NULL OR expires_at > now()); expiry is computed, never swept.
-- Users gain PENDING_APPROVAL: created, inert and unable to sign in until the user proposal is approved.
ALTER TABLE "users" ADD CONSTRAINT "users_status_ck" CHECK ("status" IN ('ACTIVE','DISABLED','PENDING_APPROVAL'));--> statement-breakpoint
CREATE TABLE "user_permission_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"effect" text NOT NULL,
	"expires_at" timestamp with time zone,
	"reason" text NOT NULL,
	"proposal_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_by" uuid,
	CONSTRAINT "user_permission_grants_effect_ck" CHECK ("user_permission_grants"."effect" IN ('GRANT','REVOKE')),
	CONSTRAINT "user_permission_grants_expiry_ck" CHECK ("user_permission_grants"."effect" = 'GRANT' OR "user_permission_grants"."expires_at" IS NULL),
	CONSTRAINT "user_permission_grants_cleared_ck" CHECK ("user_permission_grants"."cleared_by" IS NULL OR "user_permission_grants"."cleared_at" IS NOT NULL)
);--> statement-breakpoint
-- Users are disabled, never deleted (only never-approved drafts are discarded, and never with history): RESTRICT keeps the history.
ALTER TABLE "user_permission_grants" ADD CONSTRAINT "user_permission_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permission_grants" ADD CONSTRAINT "user_permission_grants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permission_grants" ADD CONSTRAINT "user_permission_grants_cleared_by_users_id_fk" FOREIGN KEY ("cleared_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- One live override per permission; it also serves loadPrincipal's per-user lookup.
CREATE UNIQUE INDEX "user_permission_grants_open_uq" ON "user_permission_grants" USING btree ("user_id","permission") WHERE "user_permission_grants"."cleared_at" IS NULL;--> statement-breakpoint
-- The table is its own history: a row changes only by being cleared, once (cleared_at, cleared_by); it is never deleted.
CREATE OR REPLACE FUNCTION ocso_guard_permission_grant() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'user_permission_grants rows are history: clear them, never delete' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.cleared_at IS NOT NULL
     OR NEW.cleared_at IS NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.permission IS DISTINCT FROM OLD.permission
     OR NEW.effect IS DISTINCT FROM OLD.effect
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'user_permission_grants rows change only by being cleared, once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER user_permission_grants_history
  BEFORE UPDATE OR DELETE ON user_permission_grants
  FOR EACH ROW EXECUTE FUNCTION ocso_guard_permission_grant();
