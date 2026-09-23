-- OCSO audit store, clickhouse driver (PM/research/11 §6.5, ADR-032). `{database}` is
-- CLICKHOUSE_DATABASE. Applied by `audit-migrate` as CLICKHOUSE_ADMIN_USER.
-- Records: a plain MergeTree. A re-shipped record is stored again; reads keep the first
-- copy per id (earliest ingested_at) and verification reports any copy whose content
-- differs (RECORD_CONFLICT), so a second insert can never silently replace a record the way
-- a ReplacingMergeTree merge would. Monthly partitions are what the purge drops.
CREATE TABLE IF NOT EXISTS {database}.audit_records (
  id UUID,
  occurred_at DateTime64(3, 'UTC'),
  actor_type LowCardinality(String),
  actor_id Nullable(String),
  actor_name Nullable(String),
  via LowCardinality(String),
  action String,
  target_type LowCardinality(String),
  target_id Nullable(String),
  summary String,
  before Nullable(String),
  after Nullable(String),
  correlation_id Nullable(String),
  confirmation Nullable(String),
  ip Nullable(String),
  team_ids Array(UUID),
  ingested_at DateTime64(6, 'UTC') DEFAULT now64(6)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (occurred_at, id)
--> statement-breakpoint
-- The hash chain. Insert deduplication tokens keyed on the first position make a second
-- sealer's insert at an already-sealed position a no-op; verification reports any fork.
CREATE TABLE IF NOT EXISTS {database}.audit_chain (
  position UInt64,
  record_id UUID,
  record_occurred_at DateTime64(3, 'UTC'),
  record_hash String,
  prev_hash String,
  chain_hash String,
  sealed_at DateTime64(3, 'UTC')
) ENGINE = MergeTree
ORDER BY position
SETTINGS non_replicated_deduplication_window = 1000
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS {database}.audit_checkpoints (
  id UUID,
  up_to_position UInt64,
  chain_hash String,
  created_at DateTime64(3, 'UTC'),
  key_id String,
  signature String
) ENGINE = MergeTree
ORDER BY (up_to_position, created_at)
SETTINGS non_replicated_deduplication_window = 1000
--> statement-breakpoint
-- Every purge (written by the purge user only): records older than `cutoff` were removed.
CREATE TABLE IF NOT EXISTS {database}.audit_purges (
  purged_at DateTime64(3, 'UTC') DEFAULT now64(3),
  cutoff DateTime64(3, 'UTC'),
  partitions Array(UInt32),
  records UInt64
) ENGINE = MergeTree
ORDER BY purged_at
--> statement-breakpoint
-- Admin-written settings: the minimum retention the driver enforces before a purge.
CREATE TABLE IF NOT EXISTS {database}.audit_store_config (
  min_retention_days UInt32,
  updated_at DateTime64(3, 'UTC') DEFAULT now64(3)
) ENGINE = MergeTree
ORDER BY updated_at
