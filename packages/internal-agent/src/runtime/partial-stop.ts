import { grantDelta, type GrantConfig } from '@ocso/application';
import type { Capability } from '../catalog/index.js';
import { stableJson } from './data.js';
import { resolveNames } from './changes.js';
import { record } from './snapshot.js';
import type { CardContext } from './cards.js';

/** Part of a governed edit that is a stop (removing a queue's team, revoking an agent's tool): it applies at once. */
export interface PartialStop {
  /** stop: the edit only removes or narrows, so it all applies at once. mixed: that part applies at once, the rest is proposed. */
  kind: 'stop' | 'mixed';
  /** What applies at once, in words. */
  now: string;
}

const names = (ids: readonly string[], known: Map<string, string>) => ids.map((id) => known.get(id) ?? id).join(', ');

/**
 * Queue and tool-grant edits mix stops with changes that need approval (routing.controller update, agent-tools
 * controller set): removals apply at once, the rest is proposed once the object is approved. Predicted here from
 * the object as the user read it, so a removal-only edit is a stop card and a mixed one says which part applies now.
 */
export async function partialStop(ctx: CardContext, capability: Capability, body: Record<string, unknown> | undefined, current: Record<string, unknown> | null): Promise<PartialStop | null> {
  if (!body || !current) return null;
  if (capability.name === 'routing.update_queue') {
    const baseline = record(body['baseline']);
    const diff = (key: string) => {
      const wanted = body[key];
      const now = current[key];
      if (!Array.isArray(wanted) || !Array.isArray(now)) return { removed: [] as string[], added: [] as string[] };
      const seen = Array.isArray(baseline?.[key]) ? (baseline[key] as unknown[]) : null;
      return { removed: (now as string[]).filter((x) => !wanted.includes(x) && (!seen || seen.includes(x))), added: (wanted as string[]).filter((x) => !now.includes(x)) };
    };
    const teams = diff('teamIds');
    const targets = diff('transferTargetIds');
    if (!teams.removed.length && !targets.removed.length) return null;
    const other = Object.entries(body).some(([k, v]) => !['teamIds', 'transferTargetIds', 'baseline'].includes(k) && v !== undefined && stableJson(v) !== stableJson(current[k]));
    const known = await resolveNames(ctx.db, ctx.principal, [...teams.removed, ...targets.removed]);
    const now = [teams.removed.length ? `removing team${teams.removed.length > 1 ? 's' : ''} ${names(teams.removed, known)}` : '', targets.removed.length ? `removing transfer target${targets.removed.length > 1 ? 's' : ''} ${names(targets.removed, known)}` : '']
      .filter(Boolean)
      .join(' and ');
    return { kind: other || teams.added.length || targets.added.length ? 'mixed' : 'stop', now };
  }
  if (capability.name === 'agents.set_agent_tools') {
    const tools = current['tools'];
    if (!Array.isArray(body['grants']) || !Array.isArray(tools)) return null;
    const entries = tools as Array<{ toolId: string; name?: string; title?: string | null; grant: Omit<GrantConfig, 'toolId'> | null }>;
    const byId = (a: GrantConfig, b: GrantConfig) => a.toolId.localeCompare(b.toolId);
    const before = entries.filter((t) => t.grant).map((t) => ({ toolId: t.toolId, ...t.grant! })).sort(byId);
    const next = (body['grants'] as Array<Partial<GrantConfig> & { toolId: string }>)
      .map((g) => ({ toolId: g.toolId, enabled: g.enabled ?? true, alwaysConfirm: g.alwaysConfirm ?? false, argumentRules: g.argumentRules ?? [] }) as GrantConfig)
      .sort(byId);
    const delta = grantDelta(before, next);
    if (!delta.removed.length && !delta.narrowed.length) return null;
    const known = new Map(entries.map((t) => [t.toolId, t.title ?? t.name ?? t.toolId]));
    const now = [
      delta.removed.length ? `revoking ${names(delta.removed, known)}` : '',
      delta.narrowed.length ? `narrowing ${names(delta.narrowed.map((g) => g.toolId), known)}` : '',
    ]
      .filter(Boolean)
      .join(' and ');
    return { kind: delta.widened.length ? 'mixed' : 'stop', now };
  }
  return null;
}

