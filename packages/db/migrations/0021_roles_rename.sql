-- Presets replace roles (PM/research/11 §3). Existing people keep their authority:
-- PLATFORM_TECH_ADMIN → TECH, CS_LEAD → HEAD, CS_EXEC → SERVICE. LEAD is new and starts empty.
ALTER TABLE "users" DROP CONSTRAINT "users_role_ck";--> statement-breakpoint
UPDATE "users" SET "role" = CASE "role"
  WHEN 'PLATFORM_TECH_ADMIN' THEN 'TECH'
  WHEN 'CS_LEAD' THEN 'HEAD'
  WHEN 'CS_EXEC' THEN 'SERVICE'
  ELSE "role" END;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_ck" CHECK ("role" IN ('TECH','HEAD','LEAD','SERVICE'));--> statement-breakpoint
-- Role lists stored as data. Wherever the old lead role was allowed, both Head and Lead are.
CREATE FUNCTION ocso_map_role_list(roles text[]) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(ARRAY(
    SELECT DISTINCT mapped FROM unnest(roles) AS r(role),
      LATERAL unnest(CASE r.role
        WHEN 'PLATFORM_TECH_ADMIN' THEN ARRAY['TECH']
        WHEN 'CS_LEAD' THEN ARRAY['HEAD','LEAD']
        WHEN 'CS_EXEC' THEN ARRAY['SERVICE']
        ELSE ARRAY[r.role] END) AS mapped
    ORDER BY mapped), '{}'::text[])
$$;--> statement-breakpoint
UPDATE "alert_rules" SET "audience_roles" = ocso_map_role_list("audience_roles");--> statement-breakpoint
UPDATE "alerts" SET "audience_roles" = ocso_map_role_list("audience_roles");--> statement-breakpoint
UPDATE "tools" SET "human_roles" = ocso_map_role_list("human_roles");--> statement-breakpoint
UPDATE "auth_policy" SET "require_mfa_roles" = ocso_map_role_list("require_mfa_roles");--> statement-breakpoint
DROP FUNCTION ocso_map_role_list(text[]);--> statement-breakpoint
ALTER TABLE "tools" ALTER COLUMN "human_roles" SET DEFAULT '{SERVICE,LEAD,HEAD}'::text[];
