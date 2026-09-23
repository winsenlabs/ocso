import type { Principal } from '@ocso/auth';
import { CAPABILITIES, capabilityByName } from './catalog/index.js';
import { allowedFor } from './runtime/search.js';

/** "What can you do?" chips, best first; each shows only when the user may use its tool. */
export const SUGGESTIONS: ReadonlyArray<{ tool: string; label: string; prompt?: string }> = [
  { tool: 'insight.attention_summary', label: 'What needs my attention?' },
  { tool: 'approvals.list_approvals', label: 'What is waiting on my approval?' },
  { tool: 'insight.list_conversations', label: 'Which conversations are waiting for a human?' },
  { tool: 'insight.agent_performance', label: 'Which agent escalates most this week?' },
  { tool: 'insight.queue_status', label: 'How are the queues doing?' },
  { tool: 'alerts.list_alerts', label: 'Are there open alerts?' },
  { tool: 'insight.latency_breakdown', label: 'Why did latency spike?', prompt: 'Why did latency spike in the last hour?' },
  { tool: 'insight.worker_capacity', label: 'Do we have enough worker capacity?' },
  { tool: 'insight.mcp_health', label: 'Which MCP connection is failing?' },
  { tool: 'agents.set_agent_status', label: 'Pause a virtual agent', prompt: 'Pause a virtual agent' },
  { tool: 'users.list_users', label: 'Who is on my team?' },
  { tool: 'insight.recent_changes', label: 'What changed recently?' },
];

const AREA_LABELS: Record<string, string> = {
  agents: 'Virtual agents',
  alerts: 'Alerts',
  analytics: 'Analytics',
  approvals: 'Approvals',
  audit: 'Audit log',
  channels: 'Channels',
  conversations: 'Conversations',
  customers: 'Customers',
  exceptions: 'Exceptions',
  health: 'Health',
  insight: 'Insights',
  mcp: 'MCP connections',
  models: 'Models',
  plugins: 'Plugins',
  quality: 'Quality',
  routers: 'Routers',
  routing: 'Queues and SLAs',
  security: 'Security',
  settings: 'Settings',
  telemetry: 'Telemetry',
  users: 'Team and access',
  webhooks: 'Webhooks',
};

export interface CapabilitySuggestions {
  suggestions: Array<{ label: string; prompt: string; tool: string }>;
  /** What this user can reach, per area: the "What can you do?" answer. */
  areas: Array<{ area: string; label: string; reads: number; writes: number }>;
  total: number;
}

/** GET /v1/internal-agent/capabilities/suggestions: chips and a per-area summary for this user's permissions. */
export function capabilitySuggestions(principal: Principal, limit = 6): CapabilitySuggestions {
  const suggestions = SUGGESTIONS.filter((s) => {
    const c = capabilityByName(s.tool);
    return c !== undefined && allowedFor(principal, c);
  })
    .slice(0, limit)
    .map((s) => ({ label: s.label, prompt: s.prompt ?? s.label, tool: s.tool }));
  const usable = CAPABILITIES.filter((c) => c.method !== 'UI' && allowedFor(principal, c));
  const byArea = new Map<string, { reads: number; writes: number }>();
  for (const c of usable) {
    const area = c.name.split('.')[0]!;
    const n = byArea.get(area) ?? { reads: 0, writes: 0 };
    if (c.risk === 'READ') n.reads++;
    else n.writes++;
    byArea.set(area, n);
  }
  const areas = [...byArea.entries()].map(([area, n]) => ({ area, label: AREA_LABELS[area] ?? area, ...n })).sort((a, b) => b.reads + b.writes - (a.reads + a.writes));
  return { suggestions, areas, total: usable.length };
}
