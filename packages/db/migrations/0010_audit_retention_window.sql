-- Audit events stay append-only (docs/archive/specs/15 §7). The only permitted mutation is
-- the retention job deleting rows older than a cutoff it declares for its own
-- transaction (SET LOCAL ocso.audit_retention_cutoff); cutoffs younger than
-- 365 days are refused here, independently of application settings.
CREATE OR REPLACE FUNCTION ocso_reject_audit_mutation() RETURNS trigger AS $$
DECLARE
  cutoff text := current_setting('ocso.audit_retention_cutoff', true);
BEGIN
  IF TG_OP = 'DELETE' AND cutoff IS NOT NULL AND cutoff <> ''
     AND cutoff::timestamptz <= now() - interval '365 days'
     AND OLD.occurred_at < cutoff::timestamptz THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
