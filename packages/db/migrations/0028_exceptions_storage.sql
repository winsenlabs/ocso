-- Exceptions and storage (PM/research/11 §7, ADR-033): the signed exception reports, daily storage
-- samples and hourly health-sample roll-ups. Hand-written to match packages/db/src/schema/exceptions.ts;
-- never generated.
CREATE TABLE "exception_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generated_by" uuid,
	"signed_at" timestamp with time zone,
	"signed_by" uuid,
	"sign_note" text,
	"signature" text,
	"key_id" text,
	"public_key_pem" text,
	"attestation" text[] DEFAULT '{}'::text[] NOT NULL,
	"superseded_by" uuid,
	CONSTRAINT "exception_reports_kind_ck" CHECK ("exception_reports"."kind" IN ('WEEKLY','ADHOC')),
	CONSTRAINT "exception_reports_status_ck" CHECK ("exception_reports"."status" IN ('DRAFT','SIGNED','SUPERSEDED')),
	CONSTRAINT "exception_reports_period_ck" CHECK ("exception_reports"."period_end" > "exception_reports"."period_start"),
	CONSTRAINT "exception_reports_signed_ck" CHECK ("exception_reports"."status" <> 'SIGNED' OR ("exception_reports"."signed_at" IS NOT NULL AND "exception_reports"."signed_by" IS NOT NULL AND "exception_reports"."signature" IS NOT NULL AND "exception_reports"."key_id" IS NOT NULL AND "exception_reports"."public_key_pem" IS NOT NULL)),
	CONSTRAINT "exception_reports_superseded_ck" CHECK ("exception_reports"."status" <> 'SUPERSEDED' OR "exception_reports"."superseded_by" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "exception_reports" ADD CONSTRAINT "exception_reports_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "exception_reports" ADD CONSTRAINT "exception_reports_signed_by_users_id_fk" FOREIGN KEY ("signed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "exception_reports_weekly_uq" ON "exception_reports" USING btree ("kind","period_start") WHERE "exception_reports"."kind" = 'WEEKLY' AND "exception_reports"."status" <> 'SUPERSEDED';
--> statement-breakpoint
-- Weekly periods chain and never overlap (a second leader, or a time-zone change, cannot cover a week twice).
ALTER TABLE "exception_reports" ADD CONSTRAINT "exception_reports_weekly_no_overlap"
  EXCLUDE USING gist (tstzrange("period_start", "period_end") WITH &&) WHERE ("kind" = 'WEEKLY' AND "status" <> 'SUPERSEDED');
--> statement-breakpoint
CREATE INDEX "exception_reports_period_idx" ON "exception_reports" USING btree ("period_start","id");
--> statement-breakpoint

-- A report is evidence: never deleted; its content never changes. The permitted UPDATEs are signing a draft
-- (DRAFT -> SIGNED with the signature columns) and superseding a draft by a regenerated report
-- (DRAFT -> SUPERSEDED with superseded_by); after either the row is frozen.
CREATE OR REPLACE FUNCTION ocso_guard_exception_report() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'exception_reports rows are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'a signed or superseded exception report is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status NOT IN ('SIGNED', 'SUPERSEDED')
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.period_start IS DISTINCT FROM OLD.period_start
     OR NEW.period_end IS DISTINCT FROM OLD.period_end
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.generated_at IS DISTINCT FROM OLD.generated_at
     OR NEW.generated_by IS DISTINCT FROM OLD.generated_by THEN
    RAISE EXCEPTION 'an exception report may only be signed or superseded, never changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'SUPERSEDED' AND (NEW.signed_at IS NOT NULL OR NEW.signed_by IS NOT NULL OR NEW.signature IS NOT NULL
     OR NEW.key_id IS NOT NULL OR NEW.public_key_pem IS NOT NULL OR NEW.sign_note IS NOT NULL OR NEW.attestation <> '{}'::text[]) THEN
    RAISE EXCEPTION 'a superseded exception report carries no signature' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'SIGNED' AND NEW.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'a signed exception report is not superseded' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER exception_reports_guard
  BEFORE UPDATE OR DELETE ON exception_reports
  FOR EACH ROW EXECUTE FUNCTION ocso_guard_exception_report();
--> statement-breakpoint
CREATE TRIGGER exception_reports_no_truncate
  BEFORE TRUNCATE ON exception_reports
  FOR EACH STATEMENT EXECUTE FUNCTION ocso_guard_exception_report();
--> statement-breakpoint
CREATE TABLE "storage_samples" (
	"day" date NOT NULL,
	"table_name" text NOT NULL,
	"rows" bigint NOT NULL,
	"bytes" bigint,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_samples_pk" PRIMARY KEY("day","table_name")
);
--> statement-breakpoint
CREATE INDEX "storage_samples_table_idx" ON "storage_samples" USING btree ("table_name","day");
--> statement-breakpoint
CREATE TABLE "health_sample_rollups" (
	"hour" timestamp with time zone NOT NULL,
	"component" text NOT NULL,
	"samples" integer DEFAULT 0 NOT NULL,
	"ok" integer DEFAULT 0 NOT NULL,
	"degraded" integer DEFAULT 0 NOT NULL,
	"down" integer DEFAULT 0 NOT NULL,
	"minutes" integer DEFAULT 0 NOT NULL,
	"up_minutes" integer DEFAULT 0 NOT NULL,
	"last_down_at" timestamp with time zone,
	"latency_avg_ms" integer,
	"latency_p95_ms" integer,
	"latency_max_ms" integer,
	"rolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_sample_rollups_pk" PRIMARY KEY("hour","component")
);
--> statement-breakpoint
CREATE INDEX "health_sample_rollups_component_idx" ON "health_sample_rollups" USING btree ("component","hour");
