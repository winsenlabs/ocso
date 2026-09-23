import { Permission as P, type Permission } from './permissions.js';

/** Section of the effective-permissions screen a permission is listed under. */
export const PERMISSION_GROUPS = [
  'Conversations',
  'Customers',
  'Agents',
  'Routing and queues',
  'Quality',
  'Channels and templates',
  'Platform',
  'Alerts',
  'People and access',
  'Approvals',
  'Audit and exceptions',
  'Ask OCSO',
] as const;
export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];

export interface PermissionInfo {
  /** Short name for a list row: "Reply to customers". */
  label: string;
  group: PermissionGroup;
  /** One sentence: what holding it lets someone do, and its limits. */
  description: string;
}

const info = (group: PermissionGroup, label: string, description: string): PermissionInfo => ({ label, group, description });

/**
 * Human description of every permission (PM/research/11 §3.1), for the
 * effective-permissions screen and GET /v1/permissions/catalogue. Every
 * catalogued permission must have an entry: rbac.test.ts enforces it.
 */
export const PERMISSION_INFO: Readonly<Record<Permission, PermissionInfo>> = {
  [P.CONVERSATIONS_READ]: info('Conversations', 'Read own conversations', 'Conversations assigned to you or waiting in queues your teams serve.'),
  [P.CONVERSATIONS_READ_TEAM]: info('Conversations', 'Oversee team conversations', "Every conversation of your teams' agents and queues, whatever its state or assignee."),
  [P.CONVERSATIONS_CLAIM]: info('Conversations', 'Claim conversations', 'Take a waiting conversation from a queue your teams serve.'),
  [P.CONVERSATIONS_TAKE_OVER]: info('Conversations', 'Take over from the AI', 'Stop the AI agent and answer the customer yourself.'),
  [P.CONVERSATIONS_REPLY]: info('Conversations', 'Reply to customers', 'Send messages to customers in conversations you handle.'),
  [P.CONVERSATIONS_NOTE]: info('Conversations', 'Write internal notes', 'Add notes that only colleagues see.'),
  [P.CONVERSATIONS_RETURN_TO_AI]: info('Conversations', 'Return to the AI', 'Hand a conversation you handle back to its AI agent.'),
  [P.CONVERSATIONS_RESOLVE]: info('Conversations', 'Resolve conversations', 'Close a conversation with a disposition.'),
  [P.CONVERSATIONS_TRANSFER]: info('Conversations', 'Transfer conversations', 'Move a conversation you handle to another queue.'),
  [P.CONVERSATIONS_ASSIGN]: info('Conversations', 'Assign conversations', 'Assign a conversation to a colleague.'),
  [P.CUSTOMERS_READ]: info('Customers', 'Read customers', 'Customer profiles of the conversations you can see.'),
  [P.CUSTOMERS_MANAGE]: info('Customers', 'Edit customers', 'Change customer profiles and attributes.'),
  [P.TOOLS_EXECUTE_HUMAN]: info('Conversations', 'Run tools', "Run an agent's business tools yourself while handling a conversation."),
  [P.TOOLS_CONFIRM_SENSITIVE]: info('Conversations', 'Confirm sensitive tool calls', 'Approve a sensitive action the AI agent asked to take.'),
  [P.COPILOT_USE]: info('Conversations', 'Use the reply copilot', 'Get suggested replies while handling a conversation.'),

  [P.AGENTS_READ]: info('Agents', 'Read agents', "Virtual agents your teams own, or reach through your teams' queues."),
  [P.AGENTS_READ_ALL]: info('Agents', 'Read every agent', 'Every virtual agent, whichever team owns it (technical fields; no transcripts).'),
  [P.AGENTS_MANAGE]: info('Agents', 'Manage agents', 'Create agents and change the agents your teams own. Taking one live needs approval.'),
  [P.AGENTS_PAUSE]: info('Agents', 'Pause agents', 'Pause an agent your teams own. Immediate; resuming needs approval.'),
  [P.AGENTS_DELETE]: info('Agents', 'Delete agents', 'Propose deleting an agent your teams own (through approval).'),
  [P.AGENTS_ASSIGN_OWNER]: info('Agents', 'Reassign agent owners', "Change any agent's owning teams, e.g. when a lead leaves."),
  [P.PROMPTS_EDIT]: info('Agents', 'Edit prompts', 'Draft prompt versions for agents your teams own.'),
  [P.PROMPTS_ACTIVATE]: info('Agents', 'Activate prompts', 'Propose making a prompt version the live one.'),
  [P.AGENT_TOOLS_MANAGE]: info('Agents', 'Manage agent tools', 'Choose which tools an agent your teams own may call.'),
  [P.ESCALATION_MANAGE]: info('Agents', 'Manage escalation rules', 'When and where an agent hands a conversation to people.'),
  [P.QUEUES_READ]: info('Routing and queues', 'Read queues', 'Queues, their teams and their live counts.'),
  [P.QUEUES_MANAGE]: info('Routing and queues', 'Manage queues', 'Create and change queues (changes to approved queues need approval).'),
  [P.ROUTERS_READ]: info('Routing and queues', 'Read routers', 'How each channel routes conversations to queues.'),
  [P.ROUTERS_MANAGE]: info('Routing and queues', 'Manage routers', 'Build routers and propose activating them.'),
  [P.SLA_MANAGE]: info('Routing and queues', 'Manage SLAs', 'Response and resolution targets.'),
  [P.TEAMS_MANAGE]: info('People and access', 'Manage teams', 'Create teams and change the teams you belong to.'),
  [P.REVIEWS_MANAGE]: info('Quality', 'Review conversations', 'Score and review conversations of your teams.'),
  [P.CORRECTIONS_MANAGE]: info('Quality', 'Manage corrections', "Record and apply corrections to agents' answers."),
  [P.ANALYTICS_BUSINESS_READ]: info('Quality', 'Business analytics', 'Volumes, outcomes and quality of your teams’ conversations.'),
  [P.MESSAGE_TEMPLATES_MANAGE]: info('Channels and templates', 'Manage message templates', 'Draft templates and propose submitting them to the provider.'),
  [P.MESSAGE_TEMPLATES_DELETE]: info('Channels and templates', 'Delete message templates', 'Propose deleting a template (through approval).'),
  [P.EVALUATIONS_RUN]: info('Quality', 'Run evaluations', 'Test agents against evaluation sets.'),

  [P.SYSTEM_READ]: info('Platform', 'Read system status', 'Health, workers and deployment facts.'),
  [P.SYSTEM_CONFIGURE]: info('Platform', 'Configure the system', 'Worker scaling, retention and other platform settings.'),
  [P.PROVIDERS_READ]: info('Platform', 'Read model providers', 'Model providers and profiles (never their keys).'),
  [P.PROVIDERS_MANAGE]: info('Platform', 'Manage model providers', 'Connect model providers (changes need approval).'),
  [P.MODEL_PROFILES_MANAGE]: info('Platform', 'Manage model profiles', 'Which model and settings agents use (changes need approval).'),
  [P.CHANNELS_READ]: info('Channels and templates', 'Read channels', 'Channels customers reach the deployment through.'),
  [P.CHANNELS_MANAGE]: info('Channels and templates', 'Manage channels', 'Connect channels and propose activating them.'),
  [P.MCP_READ]: info('Platform', 'Read MCP connections', 'Tool servers and their tools.'),
  [P.MCP_MANAGE]: info('Platform', 'Manage MCP connections', 'Connect tool servers (enabling one needs approval).'),
  [P.MCP_CONNECT_PERSONAL]: info('Platform', 'Personal MCP sign-in', 'Sign in to tool servers that act as you.'),
  [P.SECRETS_MANAGE]: info('Platform', 'Manage secrets', 'Store and rotate credentials (values are never shown back).'),
  [P.WEBHOOKS_MANAGE]: info('Platform', 'Manage webhooks', 'Outbound event subscriptions.'),
  [P.TELEMETRY_TECHNICAL_READ]: info('Platform', 'Technical telemetry', 'Traces, latency and usage (no transcript text).'),
  [P.PRICING_MANAGE]: info('Platform', 'Manage pricing', 'Model prices used for cost reporting.'),

  [P.ALERTS_TECHNICAL_READ]: info('Alerts', 'Technical alerts', 'Alerts about the platform.'),
  [P.ALERTS_BUSINESS_READ]: info('Alerts', 'Business alerts', 'Alerts about conversations, queues and agents you can see.'),
  [P.ALERTS_ACKNOWLEDGE]: info('Alerts', 'Acknowledge alerts', 'Acknowledge and resolve alerts you can see.'),
  [P.ALERT_RULES_TECHNICAL_MANAGE]: info('Alerts', 'Technical alert rules', 'Rules that raise platform alerts.'),
  [P.ALERT_RULES_BUSINESS_MANAGE]: info('Alerts', 'Business alert rules', 'Rules that raise alerts about your teams’ work.'),
  [P.NOTIFICATION_DESTINATIONS_MANAGE]: info('Alerts', 'Notification destinations', 'Where alerts are delivered (email, chat, webhooks).'),

  [P.USERS_READ]: info('People and access', 'Read people', 'Everyone with access, their preset and teams.'),
  [P.USERS_MANAGE]: info('People and access', 'Manage every user', 'Create users of any preset and change anyone’s preset and teams (increases need approval).'),
  [P.USERS_MANAGE_TEAM]: info('People and access', 'Manage team members', 'Create and change colleagues who share a team with you and whose rights do not exceed yours.'),
  [P.PERMISSIONS_READ]: info('People and access', 'Read permissions', "A colleague's effective permissions and where each came from."),
  [P.PERMISSIONS_MANAGE]: info('People and access', 'Change permissions', 'Grant and revoke single permissions. Grants need approval; revokes apply at once.'),
  [P.DEPLOYMENT_SETTINGS_MANAGE]: info('Platform', 'Deployment settings', 'Organisation name, timezone, residency and sign-in policy.'),
  [P.AUDIT_READ]: info('Audit and exceptions', 'Read the audit log', 'Changes made by your teams or to what your teams own.'),
  [P.AUDIT_READ_ALL]: info('Audit and exceptions', 'Read the whole audit log', 'Every audited change in the deployment.'),
  [P.AUDIT_VERIFY]: info('Audit and exceptions', 'Verify the audit chain', "Re-check the audit store's hash chain and signed checkpoints."),

  [P.APPROVALS_READ]: info('Approvals', 'See approvals', 'Proposals you made, proposals waiting for you, and those of your teams.'),
  [P.APPROVALS_REASSIGN_ANY]: info('Approvals', 'Reassign any approval', 'See every open approval and name a different checker.'),
  [P.APPROVALS_CHECK_AGENTS]: info('Approvals', 'Check agent changes', 'Approve agents, prompt versions, tool grants, escalation rules and business alert rules.'),
  [P.APPROVALS_CHECK_ROUTING]: info('Approvals', 'Check routing changes', 'Approve routers, queues and SLA policies.'),
  [P.APPROVALS_CHECK_CHANNELS]: info('Approvals', 'Check channel changes', 'Approve channels and message templates.'),
  [P.APPROVALS_CHECK_PLATFORM]: info('Approvals', 'Check platform changes', 'Approve model providers and profiles, MCP connections, destinations, webhooks, technical alert rules and deployment settings.'),
  [P.APPROVALS_CHECK_PERMISSIONS]: info('Approvals', 'Check access changes', 'Approve new users, preset upgrades, team additions and permission grants.'),

  [P.EXCEPTIONS_READ]: info('Audit and exceptions', 'Read exceptions', 'What went around or wrong in the controls, live and weekly.'),
  [P.EXCEPTIONS_SIGN]: info('Audit and exceptions', 'Sign exception reports', 'Sign the weekly exception report.'),

  [P.INTERNAL_AGENT_USE]: info('Ask OCSO', 'Use Ask OCSO', 'Ask the internal assistant; it acts with your own permissions.'),
};

export function permissionInfo(permission: Permission): PermissionInfo {
  return PERMISSION_INFO[permission];
}
