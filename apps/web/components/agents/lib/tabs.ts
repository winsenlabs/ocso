import { Permission } from '@ocso/auth';

/**
 * Agent detail tabs (design/02 tab strip, plus Quality and Settings). Each tab
 * is shown only to roles that can read its data; edit controls inside a tab
 * are gated separately. The API remains the enforcement point. Client-safe.
 */
export const AGENT_TABS = [
  { key: 'overview', label: 'Overview', anyOf: [Permission.AGENTS_READ] },
  { key: 'prompt', label: 'Prompt', anyOf: [Permission.AGENTS_READ] },
  { key: 'tools', label: 'Tools', anyOf: [Permission.AGENTS_READ] },
  { key: 'channels', label: 'Channels', anyOf: [Permission.CHANNELS_READ] },
  { key: 'routing', label: 'Routing', anyOf: [Permission.QUEUES_READ] },
  { key: 'escalation', label: 'Escalation', anyOf: [Permission.AGENTS_READ] },
  { key: 'analytics', label: 'Analytics', anyOf: [Permission.ANALYTICS_BUSINESS_READ] },
  { key: 'versions', label: 'Versions', anyOf: [Permission.AGENTS_READ] },
  { key: 'quality', label: 'Quality', anyOf: [Permission.CORRECTIONS_MANAGE, Permission.REVIEWS_MANAGE] },
  { key: 'settings', label: 'Settings', anyOf: [Permission.AGENTS_READ] },
] as const;

export type AgentTabKey = (typeof AGENT_TABS)[number]['key'];
export interface AgentTab {
  key: AgentTabKey;
  label: string;
}

export function permittedAgentTabs(permissions: ReadonlySet<string>): AgentTab[] {
  return AGENT_TABS.filter((t) => t.anyOf.some((p) => permissions.has(p))).map(({ key, label }) => ({ key, label }));
}

/** The requested tab when permitted, else the first permitted one (null: nothing readable). */
export function resolveAgentTab(requested: string | undefined, tabs: readonly AgentTab[]): AgentTabKey | null {
  return tabs.find((t) => t.key === requested)?.key ?? tabs[0]?.key ?? null;
}

export interface AgentHrefParams {
  tab?: AgentTabKey | undefined;
  /** Versions tab: diff endpoints and the selected evaluation run. */
  from?: string | undefined;
  to?: string | undefined;
  run?: string | undefined;
  changed?: string | undefined;
  /** Analytics window in days. */
  days?: number | undefined;
}

export function agentHref(agentId: string, params: AgentHrefParams = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    if (key === 'tab' && value === 'overview') continue;
    query.set(key, String(value));
  }
  const qs = query.toString();
  const base = `/agents/${encodeURIComponent(agentId)}`;
  return qs ? `${base}?${qs}` : base;
}

export const ANALYTICS_WINDOWS = [7, 14, 30, 90] as const;

/** ?days= for analytics; anything else falls back to 7 (the API accepts 1–90). */
export function analyticsDays(raw: string | undefined): number {
  const n = Number(raw);
  return (ANALYTICS_WINDOWS as readonly number[]).includes(n) ? n : 7;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string | undefined): value is string => !!value && UUID.test(value);

/** First string value of a search param. */
export function param(params: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const value = params[key];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first ? first : undefined;
}
