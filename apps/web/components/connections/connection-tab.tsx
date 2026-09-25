import { Permission } from '@ocso/auth';
import type { Session } from '@/lib/session';

type Grants = Pick<Session, 'permissions'>;

/**
 * The Integrations area (`/connections?tab=…`). Each section is its own
 * sidebar destination (lib/nav.ts) with its own title and one primary action,
 * so there is no tab strip across sections. The only in-page tabs are the two
 * views of MCP connections: shared servers and the user's own accounts.
 */
export const CONNECTION_SECTIONS = [
  {
    key: 'providers',
    title: 'Models',
    sub: 'The model providers OCSO may call and the model profiles virtual agents run on. Credentials are write-only and stored by reference; the model never receives them.',
    anyOf: [Permission.PROVIDERS_READ],
    primary: { label: 'Add provider', dialog: 'provider-new', requires: Permission.PROVIDERS_MANAGE },
  },
  {
    key: 'mcp',
    title: 'MCP connections',
    sub: 'Tool servers virtual agents call through MCP, and your own accounts on servers published for personal use.',
    anyOf: [Permission.MCP_READ, Permission.MCP_CONNECT_PERSONAL],
    primary: { label: 'Add MCP server', dialog: 'mcp-new', requires: Permission.MCP_MANAGE },
  },
  {
    key: 'channels',
    title: 'Channels',
    sub: 'Where customers reach your virtual agents: web chat, WhatsApp, Slack, Teams and more. Each channel stores its credentials by reference.',
    anyOf: [Permission.CHANNELS_READ],
    primary: { label: 'Add channel', dialog: 'channel-new', requires: Permission.CHANNELS_MANAGE },
  },
  {
    key: 'secrets',
    title: 'Secrets',
    sub: 'Every stored credential, by name and reference, and the keys OCSO signs customer claims with. Values are never shown again.',
    anyOf: [Permission.SECRETS_MANAGE],
    primary: null,
  },
  {
    key: 'webhooks',
    title: 'Webhooks',
    sub: 'Signed OCSO events delivered to your systems, and the callbacks channel providers post to OCSO.',
    anyOf: [Permission.WEBHOOKS_MANAGE],
    primary: { label: 'Add endpoint', dialog: 'webhook-new', requires: Permission.WEBHOOKS_MANAGE },
  },
] as const;
export type ConnectionSection = (typeof CONNECTION_SECTIONS)[number];
export type ConnectionTab = ConnectionSection['key'];

/** The two views of MCP connections (`&view=`). */
export const MCP_VIEWS = [
  { key: 'shared', label: 'Shared servers', requires: Permission.MCP_READ },
  { key: 'mine', label: 'My connections', requires: Permission.MCP_CONNECT_PERSONAL },
] as const;
export type McpView = (typeof MCP_VIEWS)[number]['key'];

/** Sections this user may open, in nav order. */
export function permittedTabs(session: Grants): ConnectionSection[] {
  return CONNECTION_SECTIONS.filter((s) => s.anyOf.some((p) => session.permissions.has(p)));
}

/** The requested section when permitted, else the first permitted one. */
export function resolveTab(value: unknown, permitted: ReadonlyArray<{ key: ConnectionTab }>): ConnectionTab | null {
  return permitted.find((t) => t.key === value)?.key ?? permitted[0]?.key ?? null;
}

/** MCP views this user may open. */
export function permittedViews(session: Grants): Array<(typeof MCP_VIEWS)[number]> {
  return MCP_VIEWS.filter((v) => session.permissions.has(v.requires));
}

/** The requested MCP view when permitted, else the first permitted one. */
export function resolveView(value: unknown, permitted: ReadonlyArray<{ key: McpView }>): McpView | null {
  return permitted.find((v) => v.key === value)?.key ?? permitted[0]?.key ?? null;
}

/** The section's header action when this user may use it (on MCP, only above the shared servers). */
export function primaryAction(section: ConnectionSection, session: Grants, view: McpView | null): { label: string; dialog: string } | null {
  const primary = section.primary;
  if (!primary || !session.permissions.has(primary.requires)) return null;
  if (section.key === 'mcp' && view !== 'shared') return null;
  return { label: primary.label, dialog: primary.dialog };
}
