import type { NavGroup } from './nav';

/**
 * Client-safe nav helpers (no permission catalogue import, so the browser
 * bundle stays small). The nav model itself is built on the server.
 */

/** Tab each /connections nav item points at when the URL has no `?tab=`. */
const DEFAULT_TABS: Readonly<Record<string, string>> = { '/connections': 'providers' };

/**
 * Key (`group:item`) of the item that best matches the current location: the
 * longest matching path wins, and a matching `?tab=` beats a bare path.
 */
export function activeNavKey(groups: readonly NavGroup[], pathname: string, tab: string | null): string | null {
  let best: { key: string; score: number } | null = null;
  for (const group of groups) {
    for (const item of group.items) {
      const score = matchScore(item.href, pathname, tab);
      if (score > 0 && (!best || score > best.score)) best = { key: `${group.key}:${item.key}`, score };
    }
  }
  return best?.key ?? null;
}

function matchScore(href: string, pathname: string, tab: string | null): number {
  const [path = '/', query = ''] = href.split('?');
  const wantTab = new URLSearchParams(query).get('tab');
  if (path === '/') return pathname === '/' ? 1 : 0;
  const exact = pathname === path;
  if (!exact && !pathname.startsWith(`${path}/`)) return 0;
  if (!wantTab) return path.length + (exact ? 1 : 0);
  const current = tab ?? DEFAULT_TABS[path] ?? null;
  return current === wantTab ? path.length + 1_000 : 0;
}

const AREA_LABELS: Readonly<Record<string, string>> = {
  '': 'home',
  conversations: 'conversations',
  queues: 'queues',
  customers: 'customers',
  alerts: 'alerts',
  agents: 'virtual agents',
  analytics: 'analytics',
  reviews: 'reviews',
  corrections: 'prompt corrections',
  'escalation-reasons': 'escalation reasons',
  sla: 'sla policies',
  team: 'team',
  system: 'system control center',
  connections: 'connections & models',
  audit: 'audit log',
  settings: 'settings',
  search: 'search',
};

/** What the Ask OCSO drawer is looking at, e.g. "system control center". */
export function areaLabel(pathname: string): string {
  const first = pathname.split('/').filter(Boolean)[0] ?? '';
  return AREA_LABELS[first] ?? first.replace(/-/g, ' ');
}
