import { Permission } from '@ocso/auth';
import type { Session } from '@/lib/session';

/** Tabs of Connections & models (design/04) plus "My connections" for personal MCP accounts. */
export const CONNECTION_TABS = [
  { key: 'providers', label: 'Model providers', requires: Permission.PROVIDERS_READ },
  { key: 'mcp', label: 'MCP connections', requires: Permission.MCP_READ },
  { key: 'channels', label: 'Channels', requires: Permission.CHANNELS_READ },
  { key: 'secrets', label: 'Secrets & credentials', requires: Permission.SECRETS_MANAGE },
  { key: 'webhooks', label: 'Webhooks', requires: Permission.WEBHOOKS_MANAGE },
  { key: 'mine', label: 'My connections', requires: Permission.MCP_CONNECT_PERSONAL },
] as const;
export type ConnectionTab = (typeof CONNECTION_TABS)[number]['key'];

/** Tabs this user may open, in design order. */
export function permittedTabs(session: Pick<Session, 'permissions'>): Array<(typeof CONNECTION_TABS)[number]> {
  return CONNECTION_TABS.filter((t) => session.permissions.has(t.requires));
}

/** The requested tab when permitted, else the first permitted one. */
export function resolveTab(value: unknown, permitted: ReadonlyArray<{ key: ConnectionTab }>): ConnectionTab | null {
  return permitted.find((t) => t.key === value)?.key ?? permitted[0]?.key ?? null;
}
