/**
 * Permission catalogue. Every privileged API route and internal-agent tool
 * declares exactly one of these; the role matrix in roles.ts grants them.
 * Resource-level checks (which conversations, which agents) live in policies/.
 */
export const Permission = {
  // Conversations & customers (operations plane)
  CONVERSATIONS_READ: 'conversations.read',
  CONVERSATIONS_READ_ALL: 'conversations.read_all',
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
  AGENTS_READ: 'agents.read',
  AGENTS_MANAGE: 'agents.manage',
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
  USERS_MANAGE_EXECS: 'users.manage_execs',
  AUDIT_READ: 'audit.read',
  DEPLOYMENT_SETTINGS_MANAGE: 'deployment_settings.manage',

  // Internal OCSO agent
  INTERNAL_AGENT_USE: 'internal_agent.use',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permission);

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as readonly string[]).includes(value);
}
