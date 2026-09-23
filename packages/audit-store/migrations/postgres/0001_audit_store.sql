-- OCSO audit store, postgres driver (PM/research/11 §6.5, ADR-032). Runs in the audit
-- database (never the main one) as the owner, through `audit-migrate`. The writer role
-- (the worker) gets INSERT/SELECT on the three data tables, SELECT on audit_purges and
-- EXECUTE on the two SECURITY DEFINER functions below; the reader role (the api) gets
-- SELECT only; neither can touch audit_store_config (granted by audit-migrate).
CREATE SEQUENCE audit_records_ingest_seq;
--> statement-breakpoint
-- Monthly range partitions on occurred_at (UTC months), created ahead of time by
-- audit_ensure_partitions and dropped whole by audit_purge_before.
CREATE TABLE audit_records (
  id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  actor_type text NOT NULL,
  actor_id text,
  actor_name text,
  via text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  summary text NOT NULL,
  before jsonb,
  after jsonb,
  correlation_id text,
  confirmation jsonb,
  ip text,
  team_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  -- Arrival order in the store: the sealer chains records in this order.
  ingest_seq bigint NOT NULL DEFAULT nextval('audit_records_ingest_seq'),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
--> statement-breakpoint
CREATE INDEX audit_records_time_idx ON audit_records (occurred_at, id);
--> statement-breakpoint
CREATE INDEX audit_records_target_idx ON audit_records (target_type, target_id, occurred_at);
--> statement-breakpoint
CREATE INDEX audit_records_actor_idx ON audit_records (actor_id, occurred_at);
--> statement-breakpoint
CREATE INDEX audit_records_teams_idx ON audit_records USING gin (team_ids);
--> statement-breakpoint
CREATE INDEX audit_records_ingest_idx ON audit_records (ingest_seq);
--> statement-breakpoint
-- The hash chain: chain_hash = sha256(prev_hash ‖ record_hash), position 1 links to 64 zeros.
CREATE TABLE audit_chain (
  position bigint PRIMARY KEY CONSTRAINT audit_chain_position_ck CHECK (position > 0),
  record_id uuid NOT NULL CONSTRAINT audit_chain_record_uq UNIQUE,
  record_occurred_at timestamptz NOT NULL,
  record_hash text NOT NULL CONSTRAINT audit_chain_record_hash_ck CHECK (record_hash ~ '^[0-9a-f]{64}$'),
  prev_hash text NOT NULL CONSTRAINT audit_chain_prev_hash_ck CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  chain_hash text NOT NULL CONSTRAINT audit_chain_chain_hash_ck CHECK (chain_hash ~ '^[0-9a-f]{64}$'),
  sealed_at timestamptz NOT NULL
);
--> statement-breakpoint
-- Ed25519 signatures over the chain hash at a position.
CREATE TABLE audit_checkpoints (
  id uuid PRIMARY KEY,
  up_to_position bigint NOT NULL REFERENCES audit_chain (position),
  chain_hash text NOT NULL CONSTRAINT audit_checkpoints_chain_hash_ck CHECK (chain_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  key_id text NOT NULL,
  signature text NOT NULL
);
--> statement-breakpoint
CREATE INDEX audit_checkpoints_position_idx ON audit_checkpoints (up_to_position);
--> statement-breakpoint
-- Append-only: UPDATE, DELETE and TRUNCATE are rejected for everyone, the owner included
-- (only whole-partition drops by audit_purge_before remove records).
CREATE FUNCTION audit_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_records_immutable BEFORE UPDATE OR DELETE ON audit_records FOR EACH ROW EXECUTE FUNCTION audit_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_records_no_truncate BEFORE TRUNCATE ON audit_records FOR EACH STATEMENT EXECUTE FUNCTION audit_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_chain_immutable BEFORE UPDATE OR DELETE ON audit_chain FOR EACH ROW EXECUTE FUNCTION audit_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_chain_no_truncate BEFORE TRUNCATE ON audit_chain FOR EACH STATEMENT EXECUTE FUNCTION audit_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_checkpoints_immutable BEFORE UPDATE OR DELETE ON audit_checkpoints FOR EACH ROW EXECUTE FUNCTION audit_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_checkpoints_no_truncate BEFORE TRUNCATE ON audit_checkpoints FOR EACH STATEMENT EXECUTE FUNCTION audit_reject_mutation();
--> statement-breakpoint
-- Owner-only settings (one row): the minimum retention audit_purge_before enforces, set by
-- audit-migrate from AUDIT_MIN_RETENTION_DAYS. The writer can neither read nor change it.
CREATE TABLE audit_store_config (
  id boolean PRIMARY KEY DEFAULT true CONSTRAINT audit_store_config_single_ck CHECK (id),
  min_retention_days integer NOT NULL DEFAULT 365 CONSTRAINT audit_store_config_retention_ck CHECK (min_retention_days >= 365)
);
--> statement-breakpoint
INSERT INTO audit_store_config DEFAULT VALUES;
--> statement-breakpoint
-- Every purge, written by audit_purge_before only: records older than `cutoff` were removed.
-- Verification counts a missing record as purged only under the newest logged cutoff.
CREATE TABLE audit_purges (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purged_at timestamptz NOT NULL DEFAULT now(),
  cutoff timestamptz NOT NULL,
  partitions text[] NOT NULL,
  records bigint NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER audit_purges_immutable BEFORE UPDATE OR DELETE ON audit_purges FOR EACH ROW EXECUTE FUNCTION audit_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_purges_no_truncate BEFORE TRUNCATE ON audit_purges FOR EACH STATEMENT EXECUTE FUNCTION audit_reject_mutation();
--> statement-breakpoint
-- Creates the monthly partitions from the month of from_ts (at most ~10 years back) to
-- months_ahead months after the current one. The writer calls it before appending.
CREATE FUNCTION audit_ensure_partitions(months_ahead integer, from_ts timestamptz DEFAULT now()) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  this_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  m date := date_trunc('month', LEAST(from_ts, now()) AT TIME ZONE 'UTC')::date;
  last_month date := (this_month + make_interval(months => GREATEST(0, LEAST(months_ahead, 24))))::date;
  earliest date := (this_month - interval '121 months')::date;
  part text;
  created integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ocso_audit_partitions'));
  IF m < earliest THEN m := earliest; END IF;
  WHILE m <= last_month LOOP
    part := format('audit_records_p%s', to_char(m, 'YYYYMM'));
    IF to_regclass(format('public.%I', part)) IS NULL THEN
      EXECUTE format('CREATE TABLE public.%I PARTITION OF public.audit_records FOR VALUES FROM (%L) TO (%L)',
        part, (m::timestamp AT TIME ZONE 'UTC'), ((m + interval '1 month')::timestamp AT TIME ZONE 'UTC'));
      EXECUTE format('CREATE TRIGGER audit_partition_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.audit_reject_mutation()', part);
      created := created + 1;
    END IF;
    m := (m + interval '1 month')::date;
  END LOOP;
  RETURN created;
END;
$$;
--> statement-breakpoint
-- Drops whole monthly partitions that end before min(cutoff, now() - min_retention_days) —
-- the floor comes from the owner-only audit_store_config, whatever the caller asks — and logs
-- the drop in audit_purges. Returns the number of records removed.
CREATE FUNCTION audit_purge_before(cutoff timestamptz) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  floor_days integer := GREATEST(365, coalesce((SELECT min_retention_days FROM public.audit_store_config), 365));
  effective timestamptz := LEAST(cutoff, now() - make_interval(days => floor_days));
  part record;
  upper_bound timestamptz;
  newest timestamptz;
  dropped text[] := '{}';
  n bigint;
  removed bigint := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ocso_audit_partitions'));
  FOR part IN
    SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'public.audit_records'::regclass AND c.relname ~ '^audit_records_p[0-9]{6}$'
     ORDER BY c.relname
  LOOP
    upper_bound := ((to_date(substr(part.relname, 16), 'YYYYMM') + interval '1 month')::timestamp AT TIME ZONE 'UTC');
    IF upper_bound <= effective THEN
      EXECUTE format('SELECT count(*) FROM public.%I', part.relname) INTO n;
      EXECUTE format('DROP TABLE public.%I', part.relname);
      removed := removed + n;
      dropped := dropped || part.relname::text;
      newest := GREATEST(newest, upper_bound);
    END IF;
  END LOOP;
  IF array_length(dropped, 1) > 0 THEN
    INSERT INTO public.audit_purges (cutoff, partitions, records) VALUES (newest, dropped, removed);
  END IF;
  RETURN removed;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_ensure_partitions(integer, timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_purge_before(timestamptz) FROM PUBLIC;
--> statement-breakpoint
SELECT audit_ensure_partitions(3);
