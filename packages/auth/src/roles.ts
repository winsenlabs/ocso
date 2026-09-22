import { Permission as P } from './permissions.js';
import type { Permission } from './permissions.js';

/** The three product roles (docs/09 §1). Do not add roles without a concrete need. */
export const Role = {
  PLATFORM_TECH_ADMIN: 'PLATFORM_TECH_ADMIN',
  CS_LEAD: 'CS_LEAD',
  CS_EXEC: 'CS_EXEC',
} as const;
export type Role = (typeof Role)[keyof typeof Role];
export const ROLES: readonly Role[] = Object.values(Role);

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  PLATFORM_TECH_ADMIN: 'Platform Tech Admin',
  CS_LEAD: 'CS Lead',
  CS_EXEC: 'CS Exec',
};

const CS_EXEC: readonly Permission[] = [
  P.CONVERSATIONS_READ,
  P.CONVERSATIONS_CLAIM,
  P.CONVERSATIONS_TAKE_OVER,
  P.CONVERSATIONS_REPLY,
  P.CONVERSATIONS_NOTE,
  P.CONVERSATIONS_RETURN_TO_AI,
  P.CONVERSATIONS_RESOLVE,
  P.CONVERSATIONS_TRANSFER,
  P.CUSTOMERS_READ,
  P.TOOLS_EXECUTE_HUMAN,
  P.TOOLS_CONFIRM_SENSITIVE,
  P.COPILOT_USE,
  P.QUEUES_READ,
  P.AGENTS_READ,
  P.ALERTS_BUSINESS_READ,
  P.ALERTS_ACKNOWLEDGE,
  P.MCP_CONNECT_PERSONAL,
  P.INTERNAL_AGENT_USE,
];

const CS_LEAD: readonly Permission[] = [
  ...CS_EXEC,
  P.CONVERSATIONS_READ_ALL,
  P.CONVERSATIONS_ASSIGN,
  P.CUSTOMERS_MANAGE,
  P.AGENTS_MANAGE,
  P.PROMPTS_EDIT,
  P.PROMPTS_ACTIVATE,
  P.AGENT_TOOLS_MANAGE,
  P.QUEUES_MANAGE,
  P.ESCALATION_MANAGE,
  P.SLA_MANAGE,
  P.TEAMS_MANAGE,
  P.REVIEWS_MANAGE,
  P.CORRECTIONS_MANAGE,
  P.ANALYTICS_BUSINESS_READ,
  P.EVALUATIONS_RUN,
  P.ALERT_RULES_BUSINESS_MANAGE,
  P.USERS_READ,
  P.USERS_MANAGE_EXECS,
  P.AUDIT_READ,
  P.CHANNELS_READ,
  P.MCP_READ,
  P.PROVIDERS_READ,
];

/**
 * Tech Admin owns the platform. Deliberately NOT granted conversation content
 * (conversations.read / read_all): technical debugging uses traces, usage and
 * turn metadata, which never include transcript text.
 */
const PLATFORM_TECH_ADMIN: readonly Permission[] = [
  P.SYSTEM_READ,
  P.SYSTEM_CONFIGURE,
  P.PROVIDERS_READ,
  P.PROVIDERS_MANAGE,
  P.MODEL_PROFILES_MANAGE,
  P.CHANNELS_READ,
  P.CHANNELS_MANAGE,
  P.MCP_READ,
  P.MCP_MANAGE,
  P.MCP_CONNECT_PERSONAL,
  P.SECRETS_MANAGE,
  P.WEBHOOKS_MANAGE,
  P.TELEMETRY_TECHNICAL_READ,
  P.PRICING_MANAGE,
  P.ALERTS_TECHNICAL_READ,
  P.ALERTS_ACKNOWLEDGE,
  P.ALERT_RULES_TECHNICAL_MANAGE,
  P.NOTIFICATION_DESTINATIONS_MANAGE,
  P.USERS_READ,
  P.USERS_MANAGE,
  P.AUDIT_READ,
  P.DEPLOYMENT_SETTINGS_MANAGE,
  P.AGENTS_READ,
  P.QUEUES_READ,
  P.INTERNAL_AGENT_USE,
];

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  PLATFORM_TECH_ADMIN: new Set(PLATFORM_TECH_ADMIN),
  CS_LEAD: new Set(CS_LEAD),
  CS_EXEC: new Set(CS_EXEC),
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsForRole(role: Role): readonly Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}
