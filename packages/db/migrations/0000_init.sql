CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"ip" text,
	"success" boolean NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_team_id_user_id_pk" PRIMARY KEY("team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"password_hash" text,
	"availability" text DEFAULT 'OFFLINE' NOT NULL,
	"max_concurrent" integer DEFAULT 8 NOT NULL,
	"languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_assigned_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"org_name" text DEFAULT 'My organization' NOT NULL,
	"deployment_label" text DEFAULT 'PROD' NOT NULL,
	"region_label" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"residency_zone" text,
	"provider_allowlist" text[] DEFAULT '{}'::text[] NOT NULL,
	"allow_cross_provider_fallback" boolean DEFAULT false NOT NULL,
	"allow_cross_region_fallback" boolean DEFAULT false NOT NULL,
	"max_output_cost_per_m_tok_micros" bigint,
	"execs_can_view_ai_active" boolean DEFAULT true NOT NULL,
	"retention" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"egress_allowed_internal_hosts" text[] DEFAULT '{}'::text[] NOT NULL,
	"setup_completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "worker_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"min_warm_workers" integer DEFAULT 2 NOT NULL,
	"max_workers" integer DEFAULT 10 NOT NULL,
	"conversations_per_worker" integer DEFAULT 10 NOT NULL,
	"target_utilization" real DEFAULT 0.75 NOT NULL,
	"scale_out_queue_age_seconds" integer DEFAULT 10 NOT NULL,
	"scale_out_queue_depth" integer DEFAULT 20 NOT NULL,
	"scale_in_cooldown_seconds" integer DEFAULT 180 NOT NULL,
	"turn_timeout_seconds" integer DEFAULT 90 NOT NULL,
	"lease_duration_seconds" integer DEFAULT 45 NOT NULL,
	"heartbeat_interval_seconds" integer DEFAULT 10 NOT NULL,
	"idle_lease_seconds" integer DEFAULT 300 NOT NULL,
	"autoscaling_enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "model_pricing" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_kind" text NOT NULL,
	"model_pattern" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"input_per_m_tok_micros" bigint NOT NULL,
	"cached_input_per_m_tok_micros" bigint,
	"cache_write_per_m_tok_micros" bigint,
	"output_per_m_tok_micros" bigint NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"provider_id" uuid NOT NULL,
	"model" text NOT NULL,
	"temperature" real,
	"max_output_tokens" integer DEFAULT 1024 NOT NULL,
	"reasoning" text,
	"timeout_ms" integer DEFAULT 30000 NOT NULL,
	"retries" integer DEFAULT 1 NOT NULL,
	"retry_backoff_ms" integer DEFAULT 400 NOT NULL,
	"cache_policy" text DEFAULT 'PREFIX' NOT NULL,
	"cache_ttl" text,
	"fallbacks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_providers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"region" text,
	"residency_zone" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"max_concurrency" integer DEFAULT 50 NOT NULL,
	"status" text DEFAULT 'UNTESTED' NOT NULL,
	"last_health_at" timestamp with time zone,
	"last_health_latency_ms" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purpose" text NOT NULL,
	"conversation_id" uuid,
	"turn_id" uuid,
	"agent_id" uuid,
	"user_id" uuid,
	"profile_id" uuid,
	"provider_id" uuid,
	"provider_kind" text,
	"model" text,
	"region" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"uncached_input_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer,
	"cache_write_tokens" integer,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer,
	"latency_ms" integer,
	"ttft_ms" integer,
	"status" text NOT NULL,
	"error_category" text,
	"fallback_from_provider_id" uuid,
	"attempt" integer DEFAULT 1 NOT NULL,
	"provider_request_id" text,
	"cost_micros" bigint,
	"currency" text,
	"trace_id" text
);
--> statement-breakpoint
CREATE TABLE "queue_teams" (
	"queue_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	CONSTRAINT "queue_teams_queue_id_team_id_pk" PRIMARY KEY("queue_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "queues" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"mode" text DEFAULT 'OPEN_PICKUP' NOT NULL,
	"auto_assign_after_seconds" integer,
	"accept_timeout_seconds" integer DEFAULT 120 NOT NULL,
	"strategy" text DEFAULT 'LEAST_ACTIVE' NOT NULL,
	"required_skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"prefer_account_owner" boolean DEFAULT true NOT NULL,
	"sla_policy_id" uuid,
	"after_hours_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sla_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"first_human_response_seconds" integer DEFAULT 900 NOT NULL,
	"pickup_seconds_by_priority" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolution_seconds_by_type" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at_risk_fraction" real DEFAULT 0.75 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_tool_grants" (
	"agent_id" uuid NOT NULL,
	"tool_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"always_confirm" boolean DEFAULT false NOT NULL,
	"argument_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_tool_grants_agent_id_tool_id_pk" PRIMARY KEY("agent_id","tool_id")
);
--> statement-breakpoint
CREATE TABLE "escalation_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid,
	"name" text NOT NULL,
	"trigger" text NOT NULL,
	"condition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mode" text DEFAULT 'OPEN_PICKUP' NOT NULL,
	"target_queue_id" uuid,
	"priority" text DEFAULT 'P3' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_corrections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid,
	"interaction_seq" integer,
	"title" text NOT NULL,
	"observed" text NOT NULL,
	"desired" text NOT NULL,
	"component_key" text NOT NULL,
	"proposed_text" text,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"source" text DEFAULT 'LEAD' NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"resulting_version_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_drafts" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"components" jsonb NOT NULL,
	"base_version_id" uuid,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"components" jsonb NOT NULL,
	"component_hashes" jsonb NOT NULL,
	"prompt_hash" text NOT NULL,
	"runtime_contract_version" text NOT NULL,
	"changed_components" text[] NOT NULL,
	"parent_version_id" uuid,
	"reason" text NOT NULL,
	"author_id" uuid,
	"correction_ids" uuid[],
	"evaluation_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_activated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "virtual_agents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"purpose" text DEFAULT '' NOT NULL,
	"conversation_type" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"active_prompt_version_id" uuid,
	"model_profile_id" uuid,
	"summarizer_profile_id" uuid,
	"copilot_profile_id" uuid,
	"default_queue_id" uuid,
	"multimodal" jsonb DEFAULT '{"imageInput":true,"documentInput":true,"audioInput":false,"maxMediaPerTurn":4}'::jsonb NOT NULL,
	"business_hours" jsonb DEFAULT '{"timezone":"UTC","humanHours":{}}'::jsonb NOT NULL,
	"mid_turn_policy" text DEFAULT 'QUEUE_BEHIND' NOT NULL,
	"max_tool_steps" integer DEFAULT 6 NOT NULL,
	"copilot_enabled" boolean DEFAULT true NOT NULL,
	"avatar_tone" text DEFAULT 'indigo' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_channels" (
	"agent_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	CONSTRAINT "agent_channels_agent_id_channel_id_pk" PRIMARY KEY("agent_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"public_key" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_agent_id" uuid,
	"last_inbound_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"display_name" text,
	"external_ref" text,
	"language" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"account_owner_user_id" uuid,
	"context_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_summaries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"covers_through_seq" integer NOT NULL,
	"kind" text DEFAULT 'ROLLING' NOT NULL,
	"text" text NOT NULL,
	"usage_event_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"channel_id" uuid,
	"type" text NOT NULL,
	"control_state" text DEFAULT 'AI_ACTIVE' NOT NULL,
	"business_status" text,
	"queue_id" uuid,
	"assigned_user_id" uuid,
	"priority" text DEFAULT 'P3' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"last_processed_seq" integer DEFAULT 0 NOT NULL,
	"last_customer_message_at" timestamp with time zone,
	"last_interaction_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_preview" text,
	"waiting_since" timestamp with time zone,
	"sla_due_at" timestamp with time zone,
	"first_human_response_at" timestamp with time zone,
	"summary_version" integer DEFAULT 0 NOT NULL,
	"disposition" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"csat_score" real,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copilot_suggestions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"based_on_seq" integer NOT NULL,
	"text" text NOT NULL,
	"rationale" text,
	"status" text DEFAULT 'READY' NOT NULL,
	"usage_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interaction_parts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"interaction_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"type" text NOT NULL,
	"content" jsonb NOT NULL,
	"blob_key" text,
	"media_status" text
);
--> statement-breakpoint
CREATE TABLE "interactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"channel_id" uuid,
	"seq" integer NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"direction" text NOT NULL,
	"visibility" text NOT NULL,
	"kind" text DEFAULT 'MESSAGE' NOT NULL,
	"correlation_id" text NOT NULL,
	"idempotency_key" text,
	"delivery_status" text DEFAULT 'NOT_APPLICABLE' NOT NULL,
	"delivery_error" text,
	"external_message_id" text,
	"turn_id" uuid,
	"preview" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "internal_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"pass_to_agent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"handoff_id" uuid,
	"kind" text NOT NULL,
	"assigned_by" uuid,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"end_reason" text
);
--> statement-breakpoint
CREATE TABLE "handoffs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"reason_code" text NOT NULL,
	"reason_text" text NOT NULL,
	"rule_id" uuid,
	"requested_by_type" text NOT NULL,
	"requested_by_id" text,
	"mode" text NOT NULL,
	"queue_id" uuid,
	"priority" text NOT NULL,
	"status" text DEFAULT 'REQUESTED' NOT NULL,
	"agent_summary" text,
	"handover_summary" text,
	"assigned_user_id" uuid,
	"declined_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"routed_at" timestamp with time zone,
	"offered_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"returned_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"auto_assign_at" timestamp with time zone,
	"offer_expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"outcome" text,
	"worker_id" text NOT NULL,
	"lease_version" integer NOT NULL,
	"seq_from" integer NOT NULL,
	"seq_to" integer NOT NULL,
	"prompt_version_id" uuid,
	"model_profile_id" uuid,
	"provider_id" uuid,
	"model" text,
	"steps" integer DEFAULT 0 NOT NULL,
	"cache_layer" text,
	"context_hashes" jsonb,
	"error_category" text,
	"error_message" text,
	"latency_ms" integer,
	"ttft_ms" integer,
	"trace_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cache_generations" (
	"scope" text PRIMARY KEY NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL,
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_snapshots" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"hashes" jsonb NOT NULL,
	"generations" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_leases" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"worker_id" text NOT NULL,
	"lease_version" bigint NOT NULL,
	"busy" boolean DEFAULT false NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "health_samples" (
	"id" uuid PRIMARY KEY NOT NULL,
	"component" text NOT NULL,
	"status" text NOT NULL,
	"latency_ms" integer,
	"detail" text,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"group_key" text,
	"dedupe_key" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"group_key" text,
	"dedupe_key" text,
	"run_at" timestamp with time zone NOT NULL,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" text PRIMARY KEY NOT NULL,
	"hostname" text NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'STARTING' NOT NULL,
	"capacity" integer NOT NULL,
	"active_leases" integer DEFAULT 0 NOT NULL,
	"busy_turns" integer DEFAULT 0 NOT NULL,
	"cpu_percent" real,
	"memory_mb" real,
	"platform_ref" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mcp_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"url" text NOT NULL,
	"network" text DEFAULT 'PUBLIC' NOT NULL,
	"scope" text DEFAULT 'SHARED' NOT NULL,
	"owner_user_id" uuid,
	"template_id" uuid,
	"auth_strategy" text DEFAULT 'NONE' NOT NULL,
	"auth_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"token_ref" text,
	"client_info_ref" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"server_info" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"protocol_version" text,
	"confirmation_policy" text DEFAULT 'SENSITIVE_ONLY' NOT NULL,
	"allowed_agent_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"granted_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"send_customer_claims" boolean DEFAULT false NOT NULL,
	"health_check_seconds" integer DEFAULT 60 NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_health_at" timestamp with time zone,
	"last_health_status" text,
	"last_health_latency_ms" integer,
	"last_error" text,
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_health_samples" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"status" text NOT NULL,
	"latency_ms" integer,
	"detail" text,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_pending" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"pending_ref" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid,
	"turn_id" uuid,
	"tool_id" uuid,
	"tool_name" text NOT NULL,
	"connection_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"on_behalf_of_user_id" uuid,
	"model_tool_call_id" text,
	"args_sanitized" jsonb NOT NULL,
	"args_hash" text NOT NULL,
	"status" text NOT NULL,
	"decision_code" text,
	"decision_reason" text,
	"confirmation_reason" text,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"confirmation_expires_at" timestamp with time zone,
	"idempotency_key" text,
	"result_summary" jsonb,
	"error_category" text,
	"error_message" text,
	"latency_ms" integer,
	"external_correlation_id" text,
	"trace_id" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid,
	"name" text NOT NULL,
	"model_name" text NOT NULL,
	"title" text,
	"description" text DEFAULT '' NOT NULL,
	"input_schema" jsonb NOT NULL,
	"output_schema" jsonb,
	"annotations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schema_hash" text NOT NULL,
	"suggested_risk" text NOT NULL,
	"risk_class" text NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"required_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"human_roles" text[] DEFAULT '{CS_EXEC,CS_LEAD}'::text[] NOT NULL,
	"changed_since_approval" boolean DEFAULT false NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"alert_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"event" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"condition" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"agent_id" uuid,
	"window_seconds" integer DEFAULT 300 NOT NULL,
	"severity" text DEFAULT 'WARNING' NOT NULL,
	"audience_roles" text[] NOT NULL,
	"destination_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"dedupe_window_seconds" integer DEFAULT 3600 NOT NULL,
	"auto_resolve" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"rule_id" uuid,
	"fingerprint" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"audience_roles" text[] NOT NULL,
	"source" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"value" text,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution" text
);
--> statement-breakpoint
CREATE TABLE "notification_destinations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_ref" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subscription_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"response_status" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"events" text[] NOT NULL,
	"signing_secret_ref" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_name" text,
	"via" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"summary" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"correlation_id" text,
	"confirmation" jsonb,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"correlation_id" text NOT NULL,
	"conversation_id" uuid,
	"agent_id" uuid,
	"payload" jsonb NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversation_insights" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"topic" text,
	"outcome" text,
	"escalation_reason" text,
	"knowledge_gap" text,
	"failure_topic" text,
	"sentiment" text,
	"sales_outcome" text,
	"turns_before_escalation" integer,
	"method_version" text NOT NULL,
	"usage_event_id" uuid,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"outcome_tag" text NOT NULL,
	"score" real NOT NULL,
	"rubric" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "csat_responses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"handled_by_human" boolean DEFAULT false NOT NULL,
	"score" integer NOT NULL,
	"comment" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"customer_text" text NOT NULL,
	"baseline_text" text,
	"candidate_text" text,
	"candidate_tool_calls" jsonb,
	"changed" boolean DEFAULT false NOT NULL,
	"flags" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"baseline_version_id" uuid,
	"candidate_components" jsonb NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"case_count" integer NOT NULL,
	"summary" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "internal_agent_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"params" jsonb NOT NULL,
	"risk" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"result" jsonb,
	"audit_event_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "internal_agent_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"role" text NOT NULL,
	"parts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "internal_agent_threads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text DEFAULT 'New conversation' NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"ref" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"used_by" text,
	"ciphertext" jsonb,
	"external_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_profiles" ADD CONSTRAINT "model_profiles_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_teams" ADD CONSTRAINT "queue_teams_queue_id_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_teams" ADD CONSTRAINT "queue_teams_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queues" ADD CONSTRAINT "queues_sla_policy_id_sla_policies_id_fk" FOREIGN KEY ("sla_policy_id") REFERENCES "public"."sla_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_grants" ADD CONSTRAINT "agent_tool_grants_agent_id_virtual_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."virtual_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_rules" ADD CONSTRAINT "escalation_rules_agent_id_virtual_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."virtual_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_rules" ADD CONSTRAINT "escalation_rules_target_queue_id_queues_id_fk" FOREIGN KEY ("target_queue_id") REFERENCES "public"."queues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_corrections" ADD CONSTRAINT "prompt_corrections_agent_id_virtual_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."virtual_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_corrections" ADD CONSTRAINT "prompt_corrections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_drafts" ADD CONSTRAINT "prompt_drafts_agent_id_virtual_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."virtual_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_drafts" ADD CONSTRAINT "prompt_drafts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_agent_id_virtual_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."virtual_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_agents" ADD CONSTRAINT "virtual_agents_model_profile_id_model_profiles_id_fk" FOREIGN KEY ("model_profile_id") REFERENCES "public"."model_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_agents" ADD CONSTRAINT "virtual_agents_summarizer_profile_id_model_profiles_id_fk" FOREIGN KEY ("summarizer_profile_id") REFERENCES "public"."model_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_agents" ADD CONSTRAINT "virtual_agents_copilot_profile_id_model_profiles_id_fk" FOREIGN KEY ("copilot_profile_id") REFERENCES "public"."model_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_agents" ADD CONSTRAINT "virtual_agents_default_queue_id_queues_id_fk" FOREIGN KEY ("default_queue_id") REFERENCES "public"."queues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_agents" ADD CONSTRAINT "virtual_agents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_channels" ADD CONSTRAINT "agent_channels_agent_id_virtual_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."virtual_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_channels" ADD CONSTRAINT "agent_channels_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_default_agent_id_virtual_agents_id_fk" FOREIGN KEY ("default_agent_id") REFERENCES "public"."virtual_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_identities" ADD CONSTRAINT "customer_identities_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_account_owner_user_id_users_id_fk" FOREIGN KEY ("account_owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_id_virtual_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."virtual_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_queue_id_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_suggestions" ADD CONSTRAINT "copilot_suggestions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_parts" ADD CONSTRAINT "interaction_parts_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_notes" ADD CONSTRAINT "internal_notes_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_notes" ADD CONSTRAINT "internal_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_queue_id_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_health_samples" ADD CONSTRAINT "mcp_health_samples_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_pending" ADD CONSTRAINT "mcp_oauth_pending_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_pending" ADD CONSTRAINT "mcp_oauth_pending_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_rule_id_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_webhook_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."webhook_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_reviews" ADD CONSTRAINT "conversation_reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_agent_actions" ADD CONSTRAINT "internal_agent_actions_thread_id_internal_agent_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."internal_agent_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_agent_actions" ADD CONSTRAINT "internal_agent_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_agent_messages" ADD CONSTRAINT "internal_agent_messages_thread_id_internal_agent_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."internal_agent_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_agent_threads" ADD CONSTRAINT "internal_agent_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "login_attempts_email_idx" ON "login_attempts" USING btree (lower("email"),"occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "team_members_user_idx" ON "team_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_name_uq" ON "teams" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "model_profiles_name_uq" ON "model_profiles" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "model_providers_name_uq" ON "model_providers" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "usage_events_time_idx" ON "usage_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "usage_events_agent_idx" ON "usage_events" USING btree ("agent_id","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_events_provider_idx" ON "usage_events" USING btree ("provider_id","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_events_profile_idx" ON "usage_events" USING btree ("profile_id","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_events_turn_idx" ON "usage_events" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "queue_teams_team_idx" ON "queue_teams" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "queues_name_uq" ON "queues" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "escalation_rules_agent_idx" ON "escalation_rules" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "prompt_corrections_agent_idx" ON "prompt_corrections" USING btree ("agent_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_agent_version_uq" ON "prompt_versions" USING btree ("agent_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "virtual_agents_slug_uq" ON "virtual_agents" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_public_key_uq" ON "channels" USING btree ("public_key");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_identities_kind_value_uq" ON "customer_identities" USING btree ("kind","value");--> statement-breakpoint
CREATE INDEX "customer_identities_customer_idx" ON "customer_identities" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_external_ref_uq" ON "customers" USING btree ("external_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_summaries_version_uq" ON "conversation_summaries" USING btree ("conversation_id","kind","version");--> statement-breakpoint
CREATE INDEX "conversations_state_idx" ON "conversations" USING btree ("control_state","queue_id","priority");--> statement-breakpoint
CREATE INDEX "conversations_customer_idx" ON "conversations" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "conversations_assigned_idx" ON "conversations" USING btree ("assigned_user_id") WHERE "conversations"."control_state" <> 'RESOLVED';--> statement-breakpoint
CREATE INDEX "conversations_agent_idx" ON "conversations" USING btree ("agent_id","opened_at");--> statement-breakpoint
CREATE INDEX "conversations_recent_idx" ON "conversations" USING btree ("last_interaction_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_open_uq" ON "conversations" USING btree ("customer_id","channel_id","agent_id") WHERE "conversations"."control_state" <> 'RESOLVED';--> statement-breakpoint
CREATE INDEX "copilot_suggestions_conversation_idx" ON "copilot_suggestions" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "interaction_parts_idx_uq" ON "interaction_parts" USING btree ("interaction_id","idx");--> statement-breakpoint
CREATE INDEX "interaction_parts_media_idx" ON "interaction_parts" USING btree ("media_status") WHERE "interaction_parts"."media_status" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "interactions_seq_uq" ON "interactions" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "interactions_idempotency_uq" ON "interactions" USING btree ("channel_id","idempotency_key") WHERE "interactions"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "interactions_external_idx" ON "interactions" USING btree ("external_message_id") WHERE "interactions"."external_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "interactions_conversation_recent_idx" ON "interactions" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "internal_notes_conversation_idx" ON "internal_notes" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "assignments_conversation_idx" ON "assignments" USING btree ("conversation_id","assigned_at");--> statement-breakpoint
CREATE INDEX "assignments_user_open_idx" ON "assignments" USING btree ("user_id") WHERE "assignments"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "handoffs_conversation_idx" ON "handoffs" USING btree ("conversation_id","requested_at");--> statement-breakpoint
CREATE INDEX "handoffs_open_idx" ON "handoffs" USING btree ("status","queue_id") WHERE "handoffs"."status" IN ('REQUESTED','WAITING','OFFERED');--> statement-breakpoint
CREATE INDEX "turns_conversation_idx" ON "turns" USING btree ("conversation_id","started_at");--> statement-breakpoint
CREATE INDEX "turns_status_idx" ON "turns" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "conversation_leases_worker_idx" ON "conversation_leases" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "conversation_leases_expiry_idx" ON "conversation_leases" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "health_samples_component_idx" ON "health_samples" USING btree ("component","sampled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_uq" ON "jobs" USING btree ("topic","dedupe_key") WHERE "jobs"."dedupe_key" IS NOT NULL AND "jobs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("topic","available_at") WHERE "jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_running_idx" ON "jobs" USING btree ("topic","locked_until") WHERE "jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "jobs_group_idx" ON "jobs" USING btree ("group_key") WHERE "jobs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "scheduled_jobs_due_idx" ON "scheduled_jobs" USING btree ("run_at") WHERE "scheduled_jobs"."dispatched_at" IS NULL;--> statement-breakpoint
CREATE INDEX "workers_heartbeat_idx" ON "workers" USING btree ("status","heartbeat_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_name_uq" ON "mcp_connections" USING btree (lower("name"),coalesce("owner_user_id"::text, ''));--> statement-breakpoint
CREATE INDEX "mcp_health_samples_idx" ON "mcp_health_samples" USING btree ("connection_id","sampled_at");--> statement-breakpoint
CREATE INDEX "tool_calls_conversation_idx" ON "tool_calls" USING btree ("conversation_id","requested_at");--> statement-breakpoint
CREATE INDEX "tool_calls_status_idx" ON "tool_calls" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "tool_calls_tool_idx" ON "tool_calls" USING btree ("tool_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tools_connection_name_uq" ON "tools" USING btree (coalesce("connection_id"::text, 'builtin'),"name");--> statement-breakpoint
CREATE UNIQUE INDEX "tools_model_name_uq" ON "tools" USING btree ("model_name");--> statement-breakpoint
CREATE INDEX "alert_deliveries_alert_idx" ON "alert_deliveries" USING btree ("alert_id");--> statement-breakpoint
CREATE INDEX "alert_rules_enabled_idx" ON "alert_rules" USING btree ("enabled","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_open_fingerprint_uq" ON "alerts" USING btree ("fingerprint") WHERE "alerts"."status" <> 'RESOLVED';--> statement-breakpoint
CREATE INDEX "alerts_status_idx" ON "alerts" USING btree ("status","opened_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_sub_idx" ON "webhook_deliveries" USING btree ("subscription_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_time_idx" ON "audit_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox_events" USING btree ("occurred_at") WHERE "outbox_events"."published_at" IS NULL;--> statement-breakpoint
CREATE INDEX "outbox_conversation_idx" ON "outbox_events" USING btree ("conversation_id","occurred_at");--> statement-breakpoint
CREATE INDEX "conversation_insights_agent_idx" ON "conversation_insights" USING btree ("agent_id","generated_at");--> statement-breakpoint
CREATE INDEX "conversation_reviews_agent_idx" ON "conversation_reviews" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "csat_responses_agent_idx" ON "csat_responses" USING btree ("agent_id","received_at");--> statement-breakpoint
CREATE INDEX "evaluation_results_run_idx" ON "evaluation_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "internal_agent_actions_user_idx" ON "internal_agent_actions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "internal_agent_messages_thread_idx" ON "internal_agent_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "internal_agent_threads_user_idx" ON "internal_agent_threads" USING btree ("user_id","updated_at");