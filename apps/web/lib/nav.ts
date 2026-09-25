import { Permission as P, type Permission } from '@ocso/auth';

/**
 * Navigation model (design/OCSONav.dc.html). Groups and items are gated on
 * permissions, never on role names, so a role's nav follows its grants in
 * packages/auth/src/roles.ts. The API still authorizes every call.
 */

export interface NavItem {
  key: string;
  label: string;
  href: string;
  kbd?: string;
}

export interface NavGroup {
  key: string;
  label?: string;
  items: NavItem[];
}

interface ItemDef extends NavItem {
  requires?: Permission;
}

interface GroupDef {
  key: string;
  label?: string;
  /** Group shows only when the user holds at least one of these. */
  gate?: readonly Permission[];
  /** ...and none of these (keeps frontline and supervisory groups apart). */
  unless?: readonly Permission[];
  items: ItemDef[];
}

const NAV: readonly GroupDef[] = [
  {
    key: 'top',
    items: [
      { key: 'home', label: 'Home', href: '/' },
      { key: 'search', label: 'Search', href: '/search', kbd: '⌘K' },
    ],
  },
  {
    key: 'my-work',
    label: 'My work',
    gate: [P.CONVERSATIONS_READ],
    unless: [P.CONVERSATIONS_READ_TEAM],
    items: [
      { key: 'conversations', label: 'Conversations', href: '/conversations', requires: P.CONVERSATIONS_READ },
      { key: 'pickup', label: 'Pickup queue', href: '/queues', requires: P.CONVERSATIONS_CLAIM },
      { key: 'customers', label: 'Customers', href: '/customers', requires: P.CUSTOMERS_READ },
      { key: 'alerts', label: 'Alerts', href: '/alerts', requires: P.ALERTS_BUSINESS_READ },
    ],
  },
  {
    key: 'operations',
    label: 'Operations',
    gate: [P.CONVERSATIONS_READ_TEAM],
    items: [
      { key: 'conversations', label: 'Conversations', href: '/conversations', requires: P.CONVERSATIONS_READ_TEAM },
      { key: 'agents', label: 'Virtual agents', href: '/agents', requires: P.AGENTS_MANAGE },
      { key: 'queues', label: 'Queues', href: '/queues', requires: P.QUEUES_MANAGE },
      // channel → router → queue → agent (PM/research/11 §5.7).
      { key: 'routers', label: 'Routers', href: '/routers', requires: P.ROUTERS_READ },
      { key: 'customers', label: 'Customers', href: '/customers', requires: P.CUSTOMERS_READ },
      // Message templates are business content (docs/07 §3); not in the OCSONav mockup, which predates them.
      { key: 'templates', label: 'Message templates', href: '/templates', requires: P.MESSAGE_TEMPLATES_MANAGE },
    ],
  },
  {
    key: 'quality',
    label: 'Quality',
    gate: [P.ANALYTICS_BUSINESS_READ],
    items: [
      { key: 'analytics', label: 'Analytics', href: '/analytics', requires: P.ANALYTICS_BUSINESS_READ },
      { key: 'reviews', label: 'Reviews', href: '/reviews', requires: P.REVIEWS_MANAGE },
      { key: 'corrections', label: 'Prompt corrections', href: '/corrections', requires: P.CORRECTIONS_MANAGE },
      { key: 'escalation-reasons', label: 'Escalation reasons', href: '/escalation-reasons', requires: P.ANALYTICS_BUSINESS_READ },
    ],
  },
  {
    key: 'governance',
    label: 'Governance',
    gate: [P.ALERT_RULES_BUSINESS_MANAGE],
    items: [
      { key: 'alerts', label: 'Alerts', href: '/alerts', requires: P.ALERTS_BUSINESS_READ },
      { key: 'sla', label: 'SLA policies', href: '/sla', requires: P.SLA_MANAGE },
      { key: 'team', label: 'Team', href: '/team', requires: P.USERS_READ },
      // Maker–checker queue (PM/research/11 §4).
      { key: 'approvals', label: 'Approvals', href: '/approvals', requires: P.APPROVALS_READ },
      // Exception report (PM/research/11 §7): live view and the weekly report a Head signs.
      { key: 'exceptions', label: 'Exceptions', href: '/exceptions', requires: P.EXCEPTIONS_READ },
    ],
  },
  {
    key: 'platform',
    label: 'Platform',
    gate: [P.SYSTEM_READ],
    items: [
      { key: 'system', label: 'System', href: '/system', requires: P.SYSTEM_READ },
      { key: 'workers', label: 'Workers', href: '/system/workers', requires: P.SYSTEM_READ },
      { key: 'system-queues', label: 'Queues & leases', href: '/system/queues', requires: P.SYSTEM_READ },
      { key: 'telemetry', label: 'Telemetry', href: '/system/telemetry', requires: P.TELEMETRY_TECHNICAL_READ },
    ],
  },
  {
    key: 'integrations',
    label: 'Integrations',
    // Readers too: a Lead or Head opens Models, MCP connections and Channels read-only.
    gate: [P.PROVIDERS_READ, P.MCP_READ, P.CHANNELS_READ, P.SECRETS_MANAGE, P.WEBHOOKS_MANAGE],
    items: [
      // Each is its own destination with its own title (components/connections/connection-tab.tsx); no tab strip repeats them.
      { key: 'models', label: 'Models', href: '/connections?tab=providers', requires: P.PROVIDERS_READ },
      // Shared servers plus the user's own accounts ("My connections" view).
      { key: 'mcp', label: 'MCP connections', href: '/connections?tab=mcp', requires: P.MCP_READ },
      { key: 'channels', label: 'Channels', href: '/connections?tab=channels', requires: P.CHANNELS_READ },
      { key: 'templates', label: 'Message templates', href: '/templates', requires: P.MESSAGE_TEMPLATES_MANAGE },
      { key: 'secrets', label: 'Secrets', href: '/connections?tab=secrets', requires: P.SECRETS_MANAGE },
      { key: 'webhooks', label: 'Webhooks', href: '/connections?tab=webhooks', requires: P.WEBHOOKS_MANAGE },
    ],
  },
  {
    key: 'oversight',
    label: 'Oversight',
    gate: [P.ALERTS_TECHNICAL_READ],
    items: [
      { key: 'alerts', label: 'Alerts', href: '/alerts', requires: P.ALERTS_TECHNICAL_READ },
      { key: 'agents', label: 'Virtual agents', href: '/agents', requires: P.AGENTS_READ },
      { key: 'audit', label: 'Audit log', href: '/audit', requires: P.AUDIT_READ },
      { key: 'routers', label: 'Routers', href: '/routers', requires: P.ROUTERS_READ },
      { key: 'team', label: 'Team & roles', href: '/team', requires: P.USERS_MANAGE },
      { key: 'approvals', label: 'Approvals', href: '/approvals', requires: P.APPROVALS_READ },
      { key: 'exceptions', label: 'Exceptions', href: '/exceptions', requires: P.EXCEPTIONS_READ },
    ],
  },
  {
    key: 'bottom',
    items: [
      // Personal MCP accounts only (e.g. Service): MCP connections opens on its "My connections" view.
      // Anyone who also reads shared servers already has this entry under Integrations.
      { key: 'mcp', label: 'MCP connections', href: '/connections?tab=mcp', requires: P.MCP_CONNECT_PERSONAL },
      { key: 'settings', label: 'Settings', href: '/settings' },
    ],
  },
];

/**
 * The nav a user with these permissions sees; empty groups are dropped. A
 * destination appears once: when two groups both offer it (e.g. Message
 * templates in Operations and Integrations), the first group keeps it.
 */
export function buildNav(permissions: ReadonlySet<Permission>): NavGroup[] {
  const has = (p: Permission) => permissions.has(p);
  const groups: NavGroup[] = [];
  const seen = new Set<string>();
  for (const def of NAV) {
    if (def.gate && !def.gate.some(has)) continue;
    if (def.unless?.some(has)) continue;
    const items = def.items
      .filter((item) => (!item.requires || has(item.requires)) && !seen.has(item.key))
      .map(({ requires: _requires, ...item }) => item);
    for (const item of items) seen.add(item.key);
    if (items.length === 0) continue;
    groups.push(def.label ? { key: def.key, label: def.label, items } : { key: def.key, items });
  }
  return groups;
}

export type HomeVariant = 'exec' | 'lead' | 'admin';

/** Which role home (design/06) a user sees, derived from what they can do. */
export function homeVariant(permissions: ReadonlySet<Permission>): HomeVariant {
  if (permissions.has(P.CONVERSATIONS_READ_TEAM)) return 'lead';
  if (permissions.has(P.CONVERSATIONS_READ)) return 'exec';
  return 'admin';
}
