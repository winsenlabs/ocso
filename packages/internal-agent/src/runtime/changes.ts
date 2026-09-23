import { sql } from 'drizzle-orm';
import { Permission, can, type Principal } from '@ocso/auth';
import { readableAgentFilter, sectionsOfDeploymentInput, type DeploymentSettingsInput, type ProposalRow } from '@ocso/application';
import { DomainError, diffFields, notFound } from '@ocso/domain';
import type { Db } from '@ocso/db';
import { capabilityByName, type Capability } from '../catalog/index.js';
import { allowedFor } from './search.js';
import { display, displayFull, label, stableJson } from './data.js';
import type { SplitArgs } from './args.js';
import type { CardChange } from './types.js';
import type { CardContext, ObjectSnapshot } from './cards.js';
export { widensRights } from './rights.js';

/** A card's before → after (PM/research/12 §5): the checker's projection for governed changes, else the object's fields. */

/** Governed writes (maker–checker): the proposal payload the route would submit, for the descriptor's after-projection. */
function proposalPayload(capability: Capability, body: Record<string, unknown> | undefined, snapshotPath: string): Record<string, unknown> | null {
  if (!body) return null;
  if (capability.approvalKind === 'deployment_settings') {
    if (capability.path === '/v1/settings/deployment') return sectionsOfDeploymentInput(body as DeploymentSettingsInput) as Record<string, unknown>;
    if (capability.path === '/v1/settings/workers') return { workers: body };
    if (capability.path === '/v1/settings/auth-policy') return { mfa: body };
    return null;
  }
  // An edit of the object itself (PATCH /v1/agents/:id) submits its body as the payload.
  return (capability.method === 'PATCH' || capability.method === 'PUT') && capability.path === snapshotPath ? body : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which name sources this user may read: exactly the rule of the list route that shows those names in the UI.
 * The catalog's permission list is not enough where a route is `@Authenticated` and its service decides (an empty
 * list reads as "any signed-in user"), so each source states its service's own rule:
 * - users: `GET /v1/users` needs users.read (UserService.list, unscoped);
 * - teams: `GET /v1/teams` is any signed-in user (TeamService.list, unscoped);
 * - queues: `GET /v1/queues` needs queues.read (QueueService.list, unscoped);
 * - model profiles: `GET /v1/model-profiles` is `@Authenticated`; ProfileService.list needs providers.read or agents.read;
 * - channels: `GET /v1/channels` needs channels.read (ChannelService.list, unscoped).
 * Agents are read through their team scope below (ADR-026). capabilities.test pins these against the catalog.
 */
export const NAME_SOURCES: ReadonlyArray<{ table: string; list: string; allowed: (principal: Principal) => boolean }> = [
  { table: 'users', list: 'users.list_users', allowed: (p) => can(p, Permission.USERS_READ) },
  { table: 'teams', list: 'users.list_teams', allowed: () => true },
  { table: 'queues', list: 'routing.list_queues', allowed: (p) => can(p, Permission.QUEUES_READ) },
  { table: 'model_profiles', list: 'models.list_profiles', allowed: (p) => can(p, Permission.PROVIDERS_READ) || can(p, Permission.AGENTS_READ) },
  { table: 'channels', list: 'channels.list_channels', allowed: (p) => can(p, Permission.CHANNELS_READ) },
];

/**
 * Names for ids a card shows (a swapped id is visible as the wrong name), only from what this user could read
 * through the UI: each table only when its list route is allowed for them, agents through the team scope (ADR-026).
 * Anything else stays an id, so a uuid planted in the arguments never leaks a name the user cannot see.
 */
export async function resolveNames(db: Db, principal: Principal, values: unknown[]): Promise<Map<string, string>> {
  const ids = [...new Set(values.flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v): v is string => typeof v === 'string' && UUID.test(v)))].slice(0, 40);
  if (!ids.length) return new Map();
  const list = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  const parts = NAME_SOURCES.filter((s) => {
    const c = capabilityByName(s.list);
    return c !== undefined && allowedFor(principal, c) && s.allowed(principal);
  }).map((s) => sql`SELECT id::text, name FROM ${sql.identifier(s.table)} WHERE id IN (${list})`);
  const agents = capabilityByName('agents.list_agents');
  if (agents && allowedFor(principal, agents)) {
    const agentScope = readableAgentFilter(principal, sql`id`);
    parts.push(sql`SELECT id::text, name FROM virtual_agents WHERE id IN (${list})${agentScope ? sql` AND ${agentScope}` : sql``}`);
  }
  if (!parts.length) return new Map();
  const { rows } = await db.execute<{ id: string; name: string }>(sql.join(parts, sql` UNION ALL `));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** A value as the card shows it: a known id as its name, else the value itself. `full`: never cut (what will be sent). */
function shown(value: unknown, names: Map<string, string>, full = true): string {
  if (typeof value === 'string' && names.has(value)) return names.get(value)!;
  if (Array.isArray(value) && value.length && value.every((v) => typeof v === 'string' && names.has(v))) return value.map((v) => names.get(v as string)!).join(', ');
  return full ? displayFull(value) : display(value);
}

/** Names for a card: what the user may read (resolveNames) plus what the object's own reads named. */
async function namesFor(ctx: CardContext, snapshot: ObjectSnapshot, values: unknown[], extra: Record<string, string> = {}): Promise<Map<string, string>> {
  const names = await resolveNames(ctx.db, ctx.principal, values);
  for (const [id, name] of Object.entries({ ...snapshot.names, ...extra })) names.set(id, name);
  return names;
}

type Diff = Array<{ path: string; before: unknown; after: unknown }>;
const diffRows = (diff: Diff, names: Map<string, string>, prefix: string): CardChange[] =>
  diff.map((d) => ({ label: `${prefix}${label(d.path)}`, before: d.before === null || d.before === undefined ? null : shown(d.before, names, false), after: shown(d.after, names) }));

/** People a proposal may be (re)assigned to, as the approvals routes name them for this user. */
async function checkerNames(ctx: CardContext, capability: Capability, current: Record<string, unknown>): Promise<Record<string, string> | null> {
  const path =
    capability.name === 'approvals.reassign_approval'
      ? `/v1/approvals/${String(current['id'])}/checkers`
      : typeof current['objectKind'] === 'string' && typeof current['objectId'] === 'string'
        ? '/v1/approvals/checkers'
        : null;
  if (!path) return null;
  const res = await ctx.runner.call(ctx.principal, ctx.scope, { method: 'GET', path, ...(path.endsWith('/checkers') && !path.includes(String(current['id'])) ? { query: { objectKind: current['objectKind'], objectId: current['objectId'] } } : {}) });
  if (res.status >= 400) return null;
  const body = res.body as Array<{ id: string; name: string }> | { checkers?: Array<{ id: string; name: string }> } | null;
  const list = Array.isArray(body) ? body : (body?.checkers ?? []);
  return Object.fromEntries(list.map((c) => [c.id, c.name]));
}

/**
 * A change to a proposal (edit, reassign, withdraw, void) or a decision on it: the proposal's own diff, the one the
 * Approvals page shows. People are named (a swapped checker id shows as the wrong name, or is refused when they
 * cannot check it); an edit shows the diff its NEW payload would propose, labelled as such.
 */
async function approvalChanges(ctx: CardContext, capability: Capability, split: SplitArgs, snapshot: ObjectSnapshot): Promise<CardChange[]> {
  const current = snapshot.current!;
  const diff = current['diff'] as Diff;
  const body = split.body ?? {};
  const person = (key: string) => (current[key] as { name?: unknown } | null)?.name;
  const checkers = typeof body['checkerId'] === 'string' ? await checkerNames(ctx, capability, current) : null;
  if (checkers && typeof body['checkerId'] === 'string' && !(body['checkerId'] in checkers)) {
    throw new DomainError('validation', 'checker_not_eligible', 'That person cannot check this proposal: choose one of the people approvals.list_checkers names for it.');
  }
  let proposed: CardChange[] | null = null;
  let payloadRow: CardChange[] = [];
  if (capability.name === 'approvals.edit_approval' && body['payload'] !== undefined) {
    const kind = current['objectKind'];
    const d = typeof kind === 'string' && ctx.approvals?.has(kind) ? ctx.approvals.get(kind) : null;
    try {
      const payload = d?.payload ? (d.payload.parse(body['payload']) as Record<string, unknown>) : (body['payload'] as Record<string, unknown>);
      const after = d ? await d.projectAfter(ctx.db, { objectKind: kind, objectId: current['objectId'], action: current['action'], payload, makerId: ctx.principal.userId } as ProposalRow) : null;
      if (after) {
        const next = diffFields(current['before'] ?? {}, after) as Diff;
        const names = await namesFor(ctx, snapshot, next.flatMap((f) => [f.before, f.after]));
        proposed = diffRows(next, names, 'new proposal · ');
      }
    } catch {
      proposed = null;
    }
    // When the new payload cannot be projected, it is shown whole and the old diff is marked as what it replaces.
    if (!proposed) payloadRow = [{ label: 'new payload', before: null, after: displayFull(body['payload']) }];
  }
  const own = Object.entries(body).filter(([k]) => k !== 'contentHash' && k !== 'dependencyHash' && k !== 'payload');
  const names = await namesFor(ctx, snapshot, [...diff.flatMap((d) => [d.before, d.after]), ...own.map(([, v]) => v)], checkers ?? {});
  const ownRows = own.map(([k, v]) => ({ label: label(k), before: k === 'checkerId' && typeof person('checker') === 'string' ? (person('checker') as string) : null, after: shown(v, names) }));
  const maker = person('maker');
  const by: CardChange[] = typeof maker === 'string' ? [{ label: 'proposed by', before: null, after: maker }] : [];
  const checker = person('checker');
  const withChecker: CardChange[] = typeof checker === 'string' && !('checkerId' in body) && capability.name !== 'approvals.decide_approval' ? [{ label: 'checker', before: null, after: checker }] : [];
  if (capability.name === 'approvals.decide_approval') return [...ownRows, ...by, ...diffRows(diff, names, 'proposed · ')];
  if (proposed) return [...ownRows, ...by, ...proposed];
  const prefix = payloadRow.length ? 'currently proposed · ' : 'proposal (unchanged) · ';
  return [...ownRows, ...payloadRow, ...by, ...withChecker, ...diffRows(diff, names, prefix)];
}

type Grant = { enabled?: boolean; alwaysConfirm?: boolean; argumentRules?: unknown[] };
const grantText = (g: Grant) => `${g.enabled === false ? 'off' : 'on'}${g.alwaysConfirm ? ', always confirm' : ''}${g.argumentRules?.length ? `, rules ${displayFull(g.argumentRules)}` : ''}`;

/** An agent's tool grants, tool by tool, named as the agent's tool list names them (never a raw tool id when it is known). */
function grantChanges(body: Record<string, unknown>, current: Record<string, unknown>): CardChange[] {
  const tools = current['tools'] as Array<{ toolId: string; name?: string; title?: string | null; connectionName?: string; grant: Grant | null }>;
  const byId = new Map(tools.map((t) => [t.toolId, t]));
  const nameOf = (id: string) => {
    const t = byId.get(id);
    return t ? `${t.title ?? t.name ?? id}${t.connectionName ? ` (${t.connectionName})` : ''}` : id;
  };
  const next = body['grants'] as Array<Grant & { toolId: string }>;
  const wanted = new Set(next.map((g) => g.toolId));
  const out: CardChange[] = [];
  for (const g of next) {
    const old = byId.get(g.toolId)?.grant ?? null;
    const after = grantText({ enabled: g.enabled ?? true, alwaysConfirm: g.alwaysConfirm ?? false, argumentRules: g.argumentRules ?? [] });
    const before = old ? grantText(old) : null;
    if (before === after) continue;
    out.push({ label: `tool · ${nameOf(g.toolId)}`, before: before ?? 'not granted', after });
  }
  for (const t of tools) if (t.grant && !wanted.has(t.toolId)) out.push({ label: `tool · ${nameOf(t.toolId)}`, before: grantText(t.grant), after: 'revoked' });
  return out;
}

/** A sensitive tool call: which tool, with what arguments, in which conversation, for which customer. */
function toolCallChanges(body: Record<string, unknown>, current: Record<string, unknown>): CardChange[] {
  const row = (label: string, value: unknown): CardChange[] => (value === null || value === undefined || value === '' ? [] : [{ label, before: null, after: displayFull(value) }]);
  return [
    ...row('tool', current['toolName']),
    ...row('arguments', current['args']),
    ...row('conversation', current['conversation']),
    ...row('customer', current['customer']),
    ...row('why the AI agent asks', current['reason']),
    ...Object.entries(body).flatMap(([k, v]) => row(label(k), v)),
  ];
}

/** `objectPath`: the path of the object's own GET route (a PATCH of that path submits its body as the payload). */
export async function changesFor(ctx: CardContext, capability: Capability, split: SplitArgs, snapshot: ObjectSnapshot, governed: boolean, objectPath: string): Promise<CardChange[]> {
  const body = split.body ?? {};
  if (snapshot.kind === 'tool_call' && snapshot.current) return toolCallChanges(body, snapshot.current);
  if (capability.method === 'DELETE') {
    return [{ label: snapshot.kind ? label(snapshot.kind) : 'object', before: snapshot.name ?? snapshot.id ?? null, after: capability.stop ? 'removed' : 'deleted' }];
  }
  if (capability.name.startsWith('approvals.') && Array.isArray(snapshot.current?.['diff'])) return approvalChanges(ctx, capability, split, snapshot);
  if (capability.name === 'agents.set_agent_tools' && Array.isArray(body['grants']) && Array.isArray(snapshot.current?.['tools'])) return grantChanges(body, snapshot.current);
  if (governed && capability.approvalKind && ctx.approvals?.has(capability.approvalKind) && snapshot.approvalId && snapshot.projection) {
    const payload = proposalPayload(capability, split.body, objectPath);
    if (payload) {
      try {
        const d = ctx.approvals.get(capability.approvalKind);
        const after = await d.projectAfter(ctx.db, { objectKind: d.kind, objectId: snapshot.approvalId, action: 'UPDATE', payload, makerId: ctx.principal.userId } as ProposalRow);
        const diff = diffFields(snapshot.projection, after);
        if (diff.length) {
          const names = await namesFor(ctx, snapshot, diff.flatMap((f) => [f.before, f.after]));
          return diffRows(diff, names, '');
        }
      } catch {
        // Fall back to the field diff below.
      }
    }
  }
  const entries = Object.entries(body).filter(([, v]) => v !== undefined);
  const names = await namesFor(ctx, snapshot, entries.flatMap(([k, v]) => [v, snapshot.current?.[k]]));
  const out: CardChange[] = [];
  for (const [key, value] of entries) {
    const before = snapshot.current && key in snapshot.current ? snapshot.current[key] : undefined;
    if (before !== undefined && stableJson(before) === stableJson(value)) continue;
    out.push({ label: label(key), before: before === undefined || before === null ? null : shown(before, names, false), after: shown(value, names) });
  }
  return out;
}


interface ProposalRead {
  id: string;
  title: string;
  objectLabel?: string;
  action?: string;
  contentHash: string;
  canDecide?: boolean;
  warnings?: Array<{ message: string; blocksBulk: boolean }>;
  diff?: Array<{ path: string; before: unknown; after: unknown }>;
}

/**
 * approvals.bulk_approve (PM/research/12 §5): every proposal in the batch, read as this checker through
 * `GET /v1/approvals/:id`, with its title and its own diff, the one the Approvals page shows. A proposal the
 * user cannot see, or one whose content hash is not the one given, ends the card: the checker approves only
 * what the card shows. Proposals with a bulk-blocking warning, or that this user cannot decide, are named.
 */
export async function bulkApprovalChanges(ctx: CardContext, split: SplitArgs): Promise<{ changes: CardChange[]; warnings: string[] }> {
  const items = (split.body?.['items'] as Array<{ id: string; contentHash: string }> | undefined) ?? [];
  if (new Set(items.map((i) => i.id)).size !== items.length) throw new DomainError('validation', 'invalid_tool_arguments', 'items lists a proposal twice');
  const reads: ProposalRead[] = [];
  for (const item of items) {
    const res = await ctx.runner.call(ctx.principal, ctx.scope, { method: 'GET', path: `/v1/approvals/${item.id}` });
    if (res.status === 404 || res.status === 403) throw notFound('approval', item.id);
    if (res.status >= 400) throw new DomainError('internal', 'object_read_failed', `Could not read proposal ${item.id}`);
    const p = res.body as ProposalRead;
    if (p.contentHash !== item.contentHash) {
      throw new DomainError('conflict', 'content_changed', `The proposal "${p.title}" changed since it was read: read it again (approvals.get_approval) and use its current contentHash.`);
    }
    reads.push(p);
  }
  const names = await resolveNames(ctx.db, ctx.principal, reads.flatMap((p) => (p.diff ?? []).flatMap((d) => [d.before, d.after])));
  const changes: CardChange[] = [];
  const warnings: string[] = [];
  if (typeof split.body?.['reason'] === 'string') changes.push({ label: 'reason', before: null, after: displayFull(split.body['reason']) });
  reads.forEach((p, i) => {
    const n = i + 1;
    changes.push({ label: `proposal ${n}`, before: null, after: `approve: ${p.title}${p.objectLabel ? ` (${p.objectLabel}${p.action ? `, ${p.action.toLowerCase()}` : ''})` : ''}` });
    for (const d of p.diff ?? []) {
      changes.push({ label: `${n} · ${label(d.path)}`, before: d.before === null || d.before === undefined ? null : shown(d.before, names, false), after: shown(d.after, names) });
    }
    if (p.canDecide === false) warnings.push(`Proposal ${n} (${p.title}) is not waiting on you: it will be skipped.`);
    for (const w of p.warnings ?? []) if (w.blocksBulk) warnings.push(`Proposal ${n} (${p.title}): ${w.message} Bulk approve skips it; decide it on its own.`);
  });
  return { changes, warnings };
}
