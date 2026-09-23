/**
 * Permission catalogue. Every privileged API route and internal-agent tool
 * declares exactly one of these; the role matrix in roles.ts grants them.
 * Resource-level checks (which conversations, which agents) live in the
 * application services: conversations/access.ts and agents/access.ts (ADR-026).
 */
export const Permission = {
  // Conversations & customers (operations plane)
  /** Conversations assigned to you or in queues your teams serve (AI-active ones only when the deployment allows). */
  CONVERSATIONS_READ: 'conversations.read',
  /**
   * Team oversight (ADR-026): every conversation handled by a virtual agent your
   * teams own or routed to a queue your teams serve, whatever its state or
   * assignee. Not "all conversations": other teams' agents stay invisible.
   */
  CONVERSATIONS_READ_TEAM: 'conversations.read_team',
  CONVERSATIONS_CLAIM: 'conversations.claim',
  CONVERSATIONS_TAKE_OVER: 'conversations.take_over',
  CONVERSATIONS_REPLY: 'conversations.reply',
  CONVERSATIONS_NOTE: 'conversations.note',
  CONVERSATIONS_RETURN_TO_AI: 'conversations.return_to_ai',
  CONVERSATIONS_RESOLVE: 'conversations.resolve',
  CONVERSATIONS_TRANSFER: 'conversations.transfer',
  CONVERSATIONS_ASSIGN: 'conversations.assign',
  CUSTOMERS_READ: 'customers.read',
  CUSTOMERS_MANAGE: 'customers.manage',
  TOOLS_EXECUTE_HUMAN: 'tools.execute_human',
  TOOLS_CONFIRM_SENSITIVE: 'tools.confirm_sensitive',
  COPILOT_USE: 'copilot.use',

  // Virtual agents & business configuration
  /** Agents your teams own; without agents.manage also agents reachable through your teams' queues (ADR-026). */
  AGENTS_READ: 'agents.read',
  /** Every virtual agent regardless of owning team (platform governance; technical fields). */
  AGENTS_READ_ALL: 'agents.read_all',
  /** Create agents and manage the agents your teams own (settings, status, owning teams within your teams). */
  AGENTS_MANAGE: 'agents.manage',
  /** Pause an agent your teams own. A stop: immediate, never gated by approval. Resuming is an approved activation. */
  AGENTS_PAUSE: 'agents.pause',
  /** Delete an agent your teams own (through approval). */
  AGENTS_DELETE: 'agents.delete',
  /** Reassign any agent's owning teams (e.g. when a lead leaves); audited. */
  AGENTS_ASSIGN_OWNER: 'agents.assign_owner',
  PROMPTS_EDIT: 'prompts.edit',
  PROMPTS_ACTIVATE: 'prompts.activate',
  AGENT_TOOLS_MANAGE: 'agent_tools.manage',
  QUEUES_READ: 'queues.read',
  QUEUES_MANAGE: 'queues.manage',
  ESCALATION_MANAGE: 'escalation.manage',
  SLA_MANAGE: 'sla.manage',
  TEAMS_MANAGE: 'teams.manage',
  REVIEWS_MANAGE: 'reviews.manage',
  CORRECTIONS_MANAGE: 'corrections.manage',
  ANALYTICS_BUSINESS_READ: 'analytics.business.read',
  /** Create, submit for the provider's review and delete message templates of channels that have them (business content; docs/07 §3). */
  MESSAGE_TEMPLATES_MANAGE: 'message_templates.manage',
  /** Delete message templates (through approval). */
  MESSAGE_TEMPLATES_DELETE: 'message_templates.delete',
  /** Routers: how a channel's conversations find their queue (PM/research/11 §5). */
  ROUTERS_READ: 'routers.read',
  ROUTERS_MANAGE: 'routers.manage',
  EVALUATIONS_RUN: 'evaluations.run',

  // Platform (control plane)
  SYSTEM_READ: 'system.read',
  SYSTEM_CONFIGURE: 'system.configure',
  PROVIDERS_READ: 'providers.read',
  PROVIDERS_MANAGE: 'providers.manage',
  MODEL_PROFILES_MANAGE: 'model_profiles.manage',
  CHANNELS_READ: 'channels.read',
  CHANNELS_MANAGE: 'channels.manage',
  MCP_READ: 'mcp.read',
  MCP_MANAGE: 'mcp.manage',
  MCP_CONNECT_PERSONAL: 'mcp.connect_personal',
  SECRETS_MANAGE: 'secrets.manage',
  WEBHOOKS_MANAGE: 'webhooks.manage',
  TELEMETRY_TECHNICAL_READ: 'telemetry.technical.read',
  PRICING_MANAGE: 'pricing.manage',

  // Alerts
  ALERTS_TECHNICAL_READ: 'alerts.technical.read',
  ALERTS_BUSINESS_READ: 'alerts.business.read',
  ALERTS_ACKNOWLEDGE: 'alerts.acknowledge',
  ALERT_RULES_TECHNICAL_MANAGE: 'alert_rules.technical.manage',
  ALERT_RULES_BUSINESS_MANAGE: 'alert_rules.business.manage',
  NOTIFICATION_DESTINATIONS_MANAGE: 'notification_destinations.manage',

  // Identity & governance
  USERS_READ: 'users.read',
  USERS_MANAGE: 'users.manage',
  /** Manage users who share a team with you and whose resulting rights do not exceed yours. */
  USERS_MANAGE_TEAM: 'users.manage_team',
  /** See a user's effective permissions and where each came from. */
  PERMISSIONS_READ: 'permissions.read',
  /** Propose per-user grants and revokes (increases go through approval; decreases apply at once). */
  PERMISSIONS_MANAGE: 'permissions.manage',
  AUDIT_READ: 'audit.read',
  /** The whole audit log; without it, audit reads are scoped to the reader's teams (ADR-026). */
  AUDIT_READ_ALL: 'audit.read_all',
  DEPLOYMENT_SETTINGS_MANAGE: 'deployment_settings.manage',
  /** Re-verify the audit store's hash chain and signed checkpoints. */
  AUDIT_VERIFY: 'audit.verify',

  // Maker–checker (PM/research/11 §4). Checking is granted per kind of object, never by level.
  APPROVALS_READ: 'approvals.read',
  /** See every open approval and name a different checker (the reassigner must also hold a check permission). */
  APPROVALS_REASSIGN_ANY: 'approvals.reassign_any',
  /** Agents, prompt versions, agent tool grants, escalation rules, business alert rules. */
  APPROVALS_CHECK_AGENTS: 'approvals.check.agents',
  /** Routers, queues, SLA policies. */
  APPROVALS_CHECK_ROUTING: 'approvals.check.routing',
  /** Channels and message templates. */
  APPROVALS_CHECK_CHANNELS: 'approvals.check.channels',
  /** Model providers and profiles, MCP connections, notification destinations, webhooks, technical alert rules, deployment settings. */
  APPROVALS_CHECK_PLATFORM: 'approvals.check.platform',
  /** New users, preset upgrades and permission grants. */
  APPROVALS_CHECK_PERMISSIONS: 'approvals.check.permissions',

  // Exceptions (PM/research/11 §7)
  EXCEPTIONS_READ: 'exceptions.read',
  /** Sign the weekly exception report. */
  EXCEPTIONS_SIGN: 'exceptions.sign',

  // Internal OCSO agent
  INTERNAL_AGENT_USE: 'internal_agent.use',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permission);

/** The permissions that let someone check (approve) a proposal of some kind. */
export const APPROVAL_CHECK_PERMISSIONS = [
  Permission.APPROVALS_CHECK_AGENTS,
  Permission.APPROVALS_CHECK_ROUTING,
  Permission.APPROVALS_CHECK_CHANNELS,
  Permission.APPROVALS_CHECK_PLATFORM,
  Permission.APPROVALS_CHECK_PERMISSIONS,
] as const satisfies readonly Permission[];

/** The permissions that let someone make (submit) a proposal of some kind; the descriptor names the exact one. */
export const APPROVAL_MAKE_PERMISSIONS = [
  Permission.AGENTS_MANAGE,
  Permission.AGENTS_DELETE,
  Permission.PROMPTS_EDIT,
  Permission.PROMPTS_ACTIVATE,
  Permission.AGENT_TOOLS_MANAGE,
  Permission.ESCALATION_MANAGE,
  Permission.QUEUES_MANAGE,
  Permission.ROUTERS_MANAGE,
  Permission.SLA_MANAGE,
  Permission.CHANNELS_MANAGE,
  Permission.MESSAGE_TEMPLATES_MANAGE,
  Permission.MESSAGE_TEMPLATES_DELETE,
  Permission.PROVIDERS_MANAGE,
  Permission.MODEL_PROFILES_MANAGE,
  Permission.MCP_MANAGE,
  Permission.WEBHOOKS_MANAGE,
  Permission.NOTIFICATION_DESTINATIONS_MANAGE,
  Permission.ALERT_RULES_TECHNICAL_MANAGE,
  Permission.ALERT_RULES_BUSINESS_MANAGE,
  Permission.USERS_MANAGE,
  Permission.USERS_MANAGE_TEAM,
  Permission.PERMISSIONS_MANAGE,
  Permission.DEPLOYMENT_SETTINGS_MANAGE,
  Permission.PRICING_MANAGE,
] as const satisfies readonly Permission[];

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as readonly string[]).includes(value);
}
