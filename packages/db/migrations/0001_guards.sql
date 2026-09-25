-- Hand-written guards that the schema DSL cannot express.

-- Audit events are immutable (docs/archive/specs/15 §7): reject UPDATE and DELETE.
CREATE OR REPLACE FUNCTION ocso_reject_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_events_immutable
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION ocso_reject_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION ocso_reject_audit_mutation();
--> statement-breakpoint

-- Prompt versions are immutable except for the first-activation stamp.
CREATE OR REPLACE FUNCTION ocso_guard_prompt_version() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
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
--> statement-breakpoint
CREATE TRIGGER prompt_versions_immutable
  BEFORE UPDATE OR DELETE ON prompt_versions
  FOR EACH ROW EXECUTE FUNCTION ocso_guard_prompt_version();
--> statement-breakpoint

-- Domain value checks (defence in depth; the application validates first).
ALTER TABLE conversations ADD CONSTRAINT conversations_control_state_ck
  CHECK (control_state IN ('AI_ACTIVE','ESCALATION_REQUESTED','WAITING_FOR_HUMAN','HUMAN_ACTIVE','AI_RESUMING','RESOLVED'));
--> statement-breakpoint
ALTER TABLE conversations ADD CONSTRAINT conversations_type_ck
  CHECK (type IN ('SUPPORT','SALES','COLLECTIONS','ONBOARDING','CUSTOM'));
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_role_ck
  CHECK (role IN ('PLATFORM_TECH_ADMIN','CS_LEAD','CS_EXEC'));
--> statement-breakpoint
ALTER TABLE interactions ADD CONSTRAINT interactions_visibility_ck
  CHECK ((visibility = 'CUSTOMER') OR (direction = 'INTERNAL'));
--> statement-breakpoint
ALTER TABLE deployment_settings ADD CONSTRAINT deployment_settings_singleton_ck CHECK (id = 1);
--> statement-breakpoint
ALTER TABLE worker_settings ADD CONSTRAINT worker_settings_singleton_ck CHECK (id = 1);
--> statement-breakpoint
ALTER TABLE worker_settings ADD CONSTRAINT worker_settings_bounds_ck CHECK (
  min_warm_workers >= 0 AND max_workers >= 1 AND min_warm_workers <= max_workers
  AND conversations_per_worker BETWEEN 1 AND 500
  AND target_utilization > 0 AND target_utilization <= 1
  AND heartbeat_interval_seconds > 0 AND lease_duration_seconds > heartbeat_interval_seconds * 2);
--> statement-breakpoint

-- Singleton rows exist from the start.
INSERT INTO deployment_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO worker_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
