-- Routing backfill (PM/research/11 §5.6): every channel that reaches an agent today (its default agent, else its
-- agent_channels row — unique per channel since 0020) gets a pass-through router to that agent's service queue,
-- so customers see no change. Service queue = the agent's default queue when no other agent already serves it;
-- else a new queue named after the agent. When the agent shared its default queue, the new queue copies that
-- queue's configuration (mode, SLA policy, skills, languages, after-hours message, hours) and its teams (plus the
-- agent's owning teams), so handoffs keep reaching the same people under the same SLA; otherwise it is staffed by
-- the agent's owning teams. Conversations without a queue join their agent's service queue. Duplicate open
-- conversations per (customer, channel) keep the one a person is working (then the newest), each superseded one
-- gets a timeline entry, and one audit entry records the migration's changes. Then the unique index swaps to
-- (customer_id, channel_id). channels.default_agent_id and agent_channels stay (deprecated, unread).
CREATE TEMP TABLE routing_channel_agent ON COMMIT DROP AS
SELECT c.id AS channel_id, c.name, COALESCE(c.default_agent_id, (SELECT ac.agent_id FROM agent_channels ac WHERE ac.channel_id = c.id ORDER BY ac.agent_id LIMIT 1)) AS agent_id
  FROM channels c;
--> statement-breakpoint
DELETE FROM routing_channel_agent WHERE agent_id IS NULL;
--> statement-breakpoint
CREATE TEMP TABLE routing_service_queue (agent_id uuid PRIMARY KEY, queue_id uuid NOT NULL, created boolean NOT NULL) ON COMMIT DROP;
--> statement-breakpoint
DO $$
DECLARE
  a record;
  ch record;
  q uuid;
  r uuid;
  v uuid;
  candidate text;
  n integer;
BEGIN
  FOR a IN
    -- The oldest agent keeps a default queue two agents share.
    SELECT va.id, va.name, va.default_queue_id, va.business_hours
      FROM virtual_agents va
     WHERE va.id IN (SELECT agent_id FROM routing_channel_agent)
     ORDER BY va.created_at, va.id
  LOOP
    q := NULL;
    IF a.default_queue_id IS NOT NULL THEN
      UPDATE queues SET agent_id = a.id, business_hours = COALESCE(business_hours, a.business_hours), updated_at = now()
       WHERE id = a.default_queue_id AND agent_id IS NULL
      RETURNING id INTO q;
    END IF;
    IF q IS NULL THEN
      candidate := a.name;
      n := 2;
      WHILE EXISTS (SELECT 1 FROM queues WHERE lower(name) = lower(candidate)) LOOP
        candidate := a.name || ' (' || n || ')';
        n := n + 1;
      END LOOP;
      q := gen_random_uuid();
      INSERT INTO queues (id, name, description, agent_id, business_hours, mode, auto_assign_after_seconds, accept_timeout_seconds, strategy,
                          required_skills, languages, prefer_account_owner, sla_policy_id, after_hours_message)
      SELECT q, candidate, 'Service queue created when routing was introduced', a.id, COALESCE(a.business_hours, d.business_hours),
             COALESCE(d.mode, 'OPEN_PICKUP'), d.auto_assign_after_seconds, COALESCE(d.accept_timeout_seconds, 120), COALESCE(d.strategy, 'LEAST_ACTIVE'),
             COALESCE(d.required_skills, '{}'::text[]), COALESCE(d.languages, '{}'::text[]), COALESCE(d.prefer_account_owner, true), d.sla_policy_id, d.after_hours_message
        FROM (SELECT 1) one LEFT JOIN queues d ON d.id = a.default_queue_id;
      INSERT INTO queue_teams (queue_id, team_id)
      SELECT q, t.team_id FROM (
        SELECT at.team_id FROM agent_teams at WHERE at.agent_id = a.id
        UNION SELECT qt.team_id FROM queue_teams qt WHERE qt.queue_id = a.default_queue_id
      ) t;
      INSERT INTO routing_service_queue VALUES (a.id, q, true);
    ELSE
      INSERT INTO routing_service_queue VALUES (a.id, q, false);
    END IF;

    -- Resolved ones too: a customer who writes again reopens into a queue (its transfers, hours and SLA).
    UPDATE conversations SET queue_id = q
     WHERE agent_id = a.id AND queue_id IS NULL;

    FOR ch IN
      SELECT rca.channel_id AS id, rca.name FROM routing_channel_agent rca
       WHERE rca.agent_id = a.id
       ORDER BY rca.channel_id
    LOOP
      candidate := ch.name;
      n := 2;
      WHILE EXISTS (SELECT 1 FROM routers WHERE lower(name) = lower(candidate)) LOOP
        candidate := ch.name || ' (' || n || ')';
        n := n + 1;
      END LOOP;
      r := gen_random_uuid();
      v := gen_random_uuid();
      INSERT INTO routers (id, name, description, status, active_version_id)
      VALUES (r, candidate, 'Pass-through router created when routing was introduced', 'ACTIVE', v);
      INSERT INTO router_versions (id, router_id, version, definition, reason)
      VALUES (v, r, 1,
              jsonb_build_object('steps', '[]'::jsonb, 'rules', '[]'::jsonb, 'fallbackQueueId', q::text, 'returning', NULL, 'timeoutMinutes', 10),
              'Created by migration 0025: this channel kept answering as its agent');
      INSERT INTO router_drafts (router_id, definition)
      SELECT v2.router_id, v2.definition FROM router_versions v2 WHERE v2.id = v;
      UPDATE channels SET router_id = r, updated_at = now() WHERE id = ch.id;
    END LOOP;
  END LOOP;
END;
$$;
--> statement-breakpoint
-- One open conversation per (customer, channel): possible duplicates only if a channel's agent changed while
-- one was open. The one a person holds stays (HUMAN_ACTIVE, then waiting for a human, then the rest), newest
-- first within each; the others are resolved and their open handoffs and assignments closed.
CREATE TEMP TABLE routing_superseded ON COMMIT DROP AS
SELECT id, kept_id FROM (
  SELECT id,
         first_value(id) OVER w AS kept_id,
         row_number() OVER w AS rn
    FROM conversations
   WHERE control_state <> 'RESOLVED' AND channel_id IS NOT NULL
  WINDOW w AS (PARTITION BY customer_id, channel_id
               ORDER BY CASE control_state WHEN 'HUMAN_ACTIVE' THEN 0 WHEN 'AI_RESUMING' THEN 1 WHEN 'WAITING_FOR_HUMAN' THEN 2 WHEN 'ESCALATION_REQUESTED' THEN 3 ELSE 4 END,
                        opened_at DESC, id DESC)
) ranked
WHERE rn > 1;
--> statement-breakpoint
-- Each superseded conversation says why in its timeline (the next seq; its state before).
CREATE TEMP TABLE routing_superseded_event ON COMMIT DROP AS
SELECT gen_random_uuid() AS interaction_id, s.id AS conversation_id, s.kept_id, c.last_seq + 1 AS seq, c.control_state AS from_state
  FROM routing_superseded s JOIN conversations c ON c.id = s.id;
--> statement-breakpoint
UPDATE conversations
   SET control_state = 'RESOLVED', disposition = 'SUPERSEDED_BY_ROUTING_MIGRATION', resolved_at = now(),
       waiting_since = NULL, version = version + 1, updated_at = now(), last_seq = last_seq + 1, last_interaction_at = now()
 WHERE id IN (SELECT id FROM routing_superseded);
--> statement-breakpoint
INSERT INTO interactions (id, conversation_id, channel_id, seq, actor_type, actor_id, direction, visibility, kind, correlation_id, delivery_status, preview, created_at)
SELECT e.interaction_id, e.conversation_id, NULL, e.seq, 'SYSTEM', NULL, 'INTERNAL', 'INTERNAL', 'SYSTEM_EVENT', 'migration:0025_routing_backfill', 'NOT_APPLICABLE', NULL, now()
  FROM routing_superseded_event e;
--> statement-breakpoint
INSERT INTO interaction_parts (id, interaction_id, idx, type, content)
SELECT gen_random_uuid(), e.interaction_id, 0, 'STRUCTURED',
       jsonb_build_object('type', 'STRUCTURED', 'schema', 'system.control_changed',
                          'data', jsonb_build_object('from', e.from_state, 'to', 'RESOLVED', 'command', 'RESOLVE', 'actorType', 'SYSTEM', 'actorId', 'migration:0025_routing_backfill', 'keptConversationId', e.kept_id),
                          'fallbackText', 'Resolved when routing was introduced: the customer has one open conversation per channel, and this one was superseded by conversation ' || e.kept_id || ' · control RESOLVED')
  FROM routing_superseded_event e;
--> statement-breakpoint
UPDATE handoffs SET status = 'CANCELLED', cancelled_at = now()
 WHERE conversation_id IN (SELECT id FROM routing_superseded) AND status IN ('REQUESTED','WAITING','OFFERED','ACTIVE');
--> statement-breakpoint
UPDATE assignments SET ended_at = now(), end_reason = 'superseded_by_routing_migration'
 WHERE conversation_id IN (SELECT id FROM routing_superseded) AND ended_at IS NULL;
--> statement-breakpoint
-- One audit entry for the migration's changes to live configuration and conversations (who: the migration);
-- none on a fresh database, where it changed nothing.
INSERT INTO audit_events (id, actor_type, actor_id, actor_name, via, action, target_type, target_id, summary, after, correlation_id)
SELECT gen_random_uuid(), 'SYSTEM', 'migration:0025_routing_backfill', 'Migration 0025', 'SYSTEM', 'routing.backfill', 'deployment', NULL,
       'Routing introduced: ' || (SELECT count(*) FROM routing_channel_agent) || ' channel(s) given a pass-through router, '
         || (SELECT count(*) FROM routing_service_queue WHERE created) || ' service queue(s) created, '
         || (SELECT count(*) FROM routing_superseded) || ' duplicate open conversation(s) resolved',
       jsonb_build_object(
         'routers', (SELECT COALESCE(jsonb_agg(jsonb_build_object('channelId', c.id, 'routerId', c.router_id) ORDER BY c.id), '[]'::jsonb) FROM channels c WHERE c.router_id IS NOT NULL),
         'serviceQueues', (SELECT COALESCE(jsonb_agg(jsonb_build_object('agentId', agent_id, 'queueId', queue_id, 'created', created) ORDER BY agent_id), '[]'::jsonb) FROM routing_service_queue),
         'superseded', (SELECT COALESCE(jsonb_agg(jsonb_build_object('conversationId', id, 'keptConversationId', kept_id) ORDER BY id), '[]'::jsonb) FROM routing_superseded)),
       'migration:0025_routing_backfill'
 WHERE EXISTS (SELECT 1 FROM routing_channel_agent) OR EXISTS (SELECT 1 FROM routing_superseded);
--> statement-breakpoint
DROP INDEX IF EXISTS "conversations_open_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_open_channel_uq" ON "conversations" USING btree ("customer_id","channel_id") WHERE "conversations"."control_state" <> 'RESOLVED';--> statement-breakpoint
-- Every turn records its agent (a conversation's agent changes on transfers from now on).
UPDATE turns t SET agent_id = c.agent_id FROM conversations c WHERE c.id = t.conversation_id AND t.agent_id IS NULL;
