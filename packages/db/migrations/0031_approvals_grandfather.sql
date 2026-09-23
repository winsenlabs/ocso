-- PM/research/11 §4, 11b "grandfather": configuration that was live before maker-checker counts as approved,
-- recorded honestly as one origin='MIGRATION' APPROVED proposal per object (no maker, no checker, activated now).
-- Its next change is a proposal; nothing that runs today changes behaviour. Each kind's set is its descriptor's
-- liveObjects() (so the exception report starts empty), widened where the owning area asked for a superset:
-- disabled routers and escalation rules (so resuming is an ACTIVATE), every queue and SLA policy, every alert
-- rule, disabled users and every model profile (v1 had no drafts). permission_change and agent_tool_grant need
-- no rows: grants are new in this release, and tool grants are covered by their agent's approval.
CREATE FUNCTION ocso_grandfather(p_kind text, p_action text, p_id uuid, p_title text, p_team_ids uuid[]) RETURNS void AS $$
  INSERT INTO approval_proposals
    (id, object_kind, object_id, action, status, origin, revision, payload, content_hash, dependency_hash, team_ids,
     title, reason, submitted_at, decided_at, decision_reason, activated_at)
  SELECT gen_random_uuid(), p_kind, p_id, p_action, 'APPROVED', 'MIGRATION', 1, '{}', 'ap_migration', 'ad_migration',
         COALESCE(p_team_ids, '{}'), p_title, 'Configuration that predates maker-checker (migration 0031)',
         now(), now(), 'Grandfathered at rollout', now()
   WHERE NOT EXISTS (SELECT 1 FROM approval_proposals WHERE object_kind = p_kind AND object_id = p_id AND status = 'APPROVED');
$$ LANGUAGE sql;
--> statement-breakpoint
SELECT ocso_grandfather('agent', 'CREATE', va.id, 'Existing virtual agent ' || va.name,
       ARRAY(SELECT team_id FROM agent_teams WHERE agent_id = va.id ORDER BY team_id))
  FROM virtual_agents va WHERE va.status IN ('LIVE', 'PAUSED');
--> statement-breakpoint
SELECT ocso_grandfather('prompt_version', 'ACTIVATE', va.active_prompt_version_id, 'Active prompt of ' || va.name,
       ARRAY(SELECT team_id FROM agent_teams WHERE agent_id = va.id ORDER BY team_id))
  FROM virtual_agents va WHERE va.status IN ('LIVE', 'PAUSED') AND va.active_prompt_version_id IS NOT NULL;
--> statement-breakpoint
SELECT ocso_grandfather('escalation_rule', 'CREATE', r.id, 'Existing escalation rule ' || r.name,
       ARRAY(SELECT team_id FROM agent_teams WHERE agent_id = r.agent_id ORDER BY team_id))
  FROM escalation_rules r WHERE r.agent_id IS NOT NULL;
--> statement-breakpoint
SELECT ocso_grandfather(CASE WHEN r.kind = 'TECHNICAL' THEN 'alert_rule_technical' ELSE 'alert_rule' END, 'CREATE', r.id,
       'Existing alert rule ' || r.name,
       CASE WHEN r.agent_id IS NULL THEN '{}'::uuid[] ELSE ARRAY(SELECT team_id FROM agent_teams WHERE agent_id = r.agent_id ORDER BY team_id) END)
  FROM alert_rules r;
--> statement-breakpoint
SELECT ocso_grandfather('message_template', 'CREATE', t.id, 'Existing message template ' || t.name, '{}')
  FROM message_templates t WHERE t.origin = 'OCSO' AND t.provider_template_id IS NOT NULL AND t.deleted_at IS NULL;
--> statement-breakpoint
SELECT ocso_grandfather('user', 'CREATE', u.id, 'Existing user ' || u.name,
       ARRAY(SELECT team_id FROM team_members WHERE user_id = u.id ORDER BY team_id))
  FROM users u WHERE u.status IN ('ACTIVE', 'DISABLED');
--> statement-breakpoint
SELECT ocso_grandfather('router', 'ACTIVATE', r.id, 'Existing router ' || r.name, '{}')
  FROM routers r WHERE r.status IN ('ACTIVE', 'DISABLED');
--> statement-breakpoint
SELECT ocso_grandfather('queue', 'CREATE', q.id, 'Existing queue ' || q.name,
       ARRAY(SELECT team_id FROM queue_teams WHERE queue_id = q.id ORDER BY team_id))
  FROM queues q;
--> statement-breakpoint
SELECT ocso_grandfather('sla_policy', 'CREATE', s.id, 'Existing SLA policy ' || s.name, '{}') FROM sla_policies s;
--> statement-breakpoint
SELECT ocso_grandfather('channel', 'CREATE', c.id, 'Existing channel ' || c.name, '{}') FROM channels c WHERE c.status = 'ACTIVE';
--> statement-breakpoint
SELECT ocso_grandfather('model_provider', 'CREATE', p.id, 'Existing model provider ' || p.name, '{}') FROM model_providers p WHERE p.enabled;
--> statement-breakpoint
SELECT ocso_grandfather('model_profile', 'CREATE', p.id, 'Existing model profile ' || p.name, '{}') FROM model_profiles p;
--> statement-breakpoint
SELECT ocso_grandfather('model_pricing', 'CREATE', p.id, 'Existing price for ' || p.provider_kind || ' ' || p.model_pattern, '{}')
  FROM model_pricing p WHERE p.status = 'ACTIVE' AND p.origin = 'manual';
--> statement-breakpoint
SELECT ocso_grandfather('mcp_connection', 'CREATE', m.id, 'Existing MCP connection ' || m.name, '{}')
  FROM mcp_connections m WHERE m.owner_user_id IS NULL AND m.approved_at IS NOT NULL AND m.status <> 'DISABLED';
--> statement-breakpoint
SELECT ocso_grandfather('notification_destination', 'CREATE', d.id, 'Existing notification destination ' || d.name, '{}')
  FROM notification_destinations d WHERE d.enabled;
--> statement-breakpoint
SELECT ocso_grandfather('webhook_subscription', 'CREATE', w.id, 'Existing webhook ' || w.name, '{}')
  FROM webhook_subscriptions w WHERE w.enabled;
--> statement-breakpoint
SELECT ocso_grandfather('sso_provider', 'CREATE', s.id, 'Existing SSO provider ' || COALESCE(s.name, s.domain, s.provider_id), '{}')
  FROM auth_sso_providers s WHERE s.status = 'ACTIVE';
--> statement-breakpoint
SELECT ocso_grandfather('deployment_settings', 'UPDATE', '00000000-0000-4000-8000-000000000001', 'Deployment settings', '{}');
--> statement-breakpoint
DROP FUNCTION ocso_grandfather(text, text, uuid, text, uuid[]);
