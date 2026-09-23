import { Permission as P } from './permissions.js';
import type { Permission } from './permissions.js';

/**
 * The four presets (PM/research/11 §3). A user's rights start from their
 * preset; per-user grants and revokes (user_permission_grants) adjust them, and
 * everything stays scoped to the teams the user belongs to. Rules — including
 * who may check whose work — are written in permissions, never in these names.
 */
export const Role = {
  TECH: 'TECH',
  HEAD: 'HEAD',
  LEAD: 'LEAD',
  SERVICE: 'SERVICE',
} as const;
export type Role = (typeof Role)[keyof typeof Role];
export const ROLES: readonly Role[] = Object.values(Role);

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  TECH: 'Tech',
  HEAD: 'Head',
  LEAD: 'Lead',
  SERVICE: 'Service',
};

/** Frontline: handles the conversations of their teams' queues. */
const SERVICE: readonly Permission[] = [
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
  P.APPROVALS_READ,
];

/** Runs their teams: drafts and proposes configuration; cannot check anyone's work. Pausing is a stop, never gated. */
const LEAD: readonly Permission[] = [
  ...SERVICE,
  P.CONVERSATIONS_READ_TEAM,
  P.CONVERSATIONS_ASSIGN,
  P.CUSTOMERS_MANAGE,
  P.AGENTS_MANAGE,
  P.AGENTS_PAUSE,
  P.PROMPTS_EDIT,
  P.PROMPTS_ACTIVATE,
  P.AGENT_TOOLS_MANAGE,
  P.QUEUES_MANAGE,
  P.ROUTERS_READ,
  P.ROUTERS_MANAGE,
  P.ESCALATION_MANAGE,
  P.SLA_MANAGE,
  P.REVIEWS_MANAGE,
  P.CORRECTIONS_MANAGE,
  P.ANALYTICS_BUSINESS_READ,
  P.EVALUATIONS_RUN,
  P.MESSAGE_TEMPLATES_MANAGE,
  P.ALERT_RULES_BUSINESS_MANAGE,
  P.USERS_READ,
  P.USERS_MANAGE_TEAM,
  P.AUDIT_READ,
  P.CHANNELS_READ,
  P.MCP_READ,
  P.PROVIDERS_READ,
  P.PERMISSIONS_READ,
];

/** Full authority inside their teams: checks Leads' and other Heads' work, deletes, signs the exception report. */
const HEAD: readonly Permission[] = [
  ...LEAD,
  P.TEAMS_MANAGE,
  P.AGENTS_DELETE,
  P.MESSAGE_TEMPLATES_DELETE,
  P.APPROVALS_CHECK_AGENTS,
  P.APPROVALS_CHECK_ROUTING,
  P.APPROVALS_CHECK_CHANNELS,
  P.APPROVALS_CHECK_PLATFORM,
  P.APPROVALS_CHECK_PERMISSIONS,
  P.PERMISSIONS_MANAGE,
  P.EXCEPTIONS_READ,
  P.EXCEPTIONS_SIGN,
];

/**
 * Tech owns the platform. Deliberately NOT granted conversation content
 * (conversations.read / read_team): technical debugging uses traces, usage and
 * turn metadata, which never include transcript text. Reads every agent and
 * reassigns owning teams (governance), but never edits prompts, tools or go-live,
 * and checks only platform and permission changes.
 */
const TECH: readonly Permission[] = [
  P.SYSTEM_READ,
  P.SYSTEM_CONFIGURE,
  P.PROVIDERS_READ,
  P.PROVIDERS_MANAGE,
  P.MODEL_PROFILES_MANAGE,
  P.CHANNELS_READ,
  P.CHANNELS_MANAGE,
  P.MESSAGE_TEMPLATES_MANAGE,
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
  P.AUDIT_READ_ALL,
  P.AUDIT_VERIFY,
  P.DEPLOYMENT_SETTINGS_MANAGE,
  P.AGENTS_READ,
  P.AGENTS_READ_ALL,
  P.AGENTS_ASSIGN_OWNER,
  P.QUEUES_READ,
  P.ROUTERS_READ,
  P.INTERNAL_AGENT_USE,
  P.APPROVALS_READ,
  P.APPROVALS_REASSIGN_ANY,
  P.APPROVALS_CHECK_PLATFORM,
  P.APPROVALS_CHECK_PERMISSIONS,
  P.PERMISSIONS_READ,
  P.PERMISSIONS_MANAGE,
  P.EXCEPTIONS_READ,
];

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  TECH: new Set(TECH),
  HEAD: new Set(HEAD),
  LEAD: new Set(LEAD),
  SERVICE: new Set(SERVICE),
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsForRole(role: Role): readonly Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}
