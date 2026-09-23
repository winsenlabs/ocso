import { eq } from 'drizzle-orm';
import { SETTINGS_OBJECT_ID } from '@ocso/application';
import { DomainError, forbidden, notFound } from '@ocso/domain';
import { toolCalls } from '@ocso/db';
import { CAPABILITIES, capabilityByName, fillPath, isAppRoute, type Capability } from '../catalog/index.js';
import { allowedFor } from './search.js';
import { label, nameOf, rowsOf } from './data.js';
import { resolveNames } from './changes.js';
import type { SplitArgs } from './args.js';
import { apiError, type CardChange } from './types.js';
import type { CardContext } from './cards.js';

/**
 * The object a write acts on, read as the user (PM/research/12 §5): its own GET route, else its list (or the read
 * above it that lists it), the objects its path names besides it, and the approval object the route governs.
 */

/** The object a write acts on, as the user may see it now. */
export interface ObjectSnapshot {
  kind: string | null;
  /** The object the card shows (for a create into a collection, the parent it is created in). */
  id: string | null;
  name: string | null;
  href: string | null;
  /** The object's own GET route's answer, as this user. */
  current: Record<string, unknown> | null;
  /** The approval descriptor's checker projection, for governed kinds. */
  projection: Record<string, unknown> | null;
  /** The approval object the route governs: null for a create (there is no object yet) and for ungoverned routes. */
  approvalId: string | null;
  /** Names the object's own reads gave for ids on the card (a conversation's tools, an agent's tool grants). */
  names: Record<string, string>;
  /** The other objects the path names (the team of a membership, the agent of a rule), as card rows. */
  context: CardChange[];
}

const ACTION_SEGMENT = /^[a-z][a-z-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/v1/agents/:agentId/tools` → `/v1/agents/:/tools`: routes with the same shape are the same route to Express. */
const shape = (path: string) => path.replace(/:\w+/g, ':');
export const paramNames = (path: string) => [...path.matchAll(/:(\w+)/g)].map((m) => m[1]!);
let getsByShape: Map<string, Capability> | null = null;
function getAt(path: string): Capability | undefined {
  getsByShape ??= new Map(CAPABILITIES.filter((c) => c.method === 'GET').map((c) => [shape(c.path), c]));
  return getsByShape.get(shape(path));
}

/** The write's arguments under the read's own parameter names (the read's path is a prefix of the write's, param for param). */
function paramsFor(read: Capability, capability: Capability, params: Record<string, unknown>): Record<string, unknown> {
  const mine = paramNames(capability.path);
  return Object.fromEntries(paramNames(read.path).map((name, i) => [name, params[mine[i] ?? name]]));
}

/**
 * The GET route that reads the object a write acts on: the write's own path (a singleton such as
 * `/v1/settings/deployment`, or `PATCH /v1/agents/:id`), else the path without its trailing action segments
 * (`POST /v1/agents/:id/status` → `/v1/agents/:id`). A POST to a collection creates: there is no object yet.
 * Parameter names may differ (`/v1/conversations/:conversationId/csat` is read by `GET /v1/conversations/:id`).
 */
export function objectReadCapability(capability: Capability): Capability | null {
  if (capability.method === 'GET' || capability.method === 'INSIGHT' || capability.method === 'UI') return null;
  const segments = capability.path.split('/');
  if (capability.method !== 'POST' && getAt(capability.path)) return getAt(capability.path)!;
  while (segments.length > 2) {
    const last = segments.at(-1)!;
    if (last.startsWith(':')) return getAt(segments.join('/')) ?? null;
    if (!ACTION_SEGMENT.test(last)) return null;
    segments.pop();
    if (segments.at(-1)?.startsWith(':')) return getAt(segments.join('/')) ?? null;
  }
  return null;
}

/**
 * Whether the write creates a governed object (`POST /v1/users`, `POST /v1/agents/:agentId/escalation-rules`): a POST
 * to a collection that has its own list route. There is no object yet, so no approval object id: the path's last
 * parameter (the agent, the channel) names the parent, never the new rule or template.
 */
export function createsGovernedObject(capability: Capability): boolean {
  if (capability.method !== 'POST' || !capability.approvalKind || capability.approvalKind === 'permission_change') return false;
  const last = capability.path.split('/').at(-1) ?? '';
  return !last.startsWith(':') && getAt(capability.path) !== undefined;
}

/**
 * The approval object id a governed route acts on (always a row uuid). A route addressed by a slug
 * (`/v1/settings/sso-providers/:providerId`) uses the row id its object read resolved (`resolvedId`).
 */
function approvalObjectId(capability: Capability, split: SplitArgs, resolvedId: string | null): string | null {
  if (capability.approvalKind === 'deployment_settings') return SETTINGS_OBJECT_ID;
  if (capability.approvalKind === 'permission_change' && typeof split.body?.['userId'] === 'string') return split.body['userId'];
  const last = paramNames(capability.path).at(-1);
  const value = last ? split.params[last] : undefined;
  if (typeof value === 'string' && UUID.test(value)) return value;
  return resolvedId && UUID.test(resolvedId) ? resolvedId : null;
}

const readKind = (read: Capability | null | undefined): string | null => (read ? (read.name.split('.')[1] ?? '').replace(/^get_/, '') || null : null);
/** `escalation-rules` → `escalation_rule`, `policies` → `policy`. */
const singular = (segment: string) => segment.replace(/-/g, '_').replace(/ies$/, 'y').replace(/s$/, '');

function hrefFor(pattern: string | undefined, values: Record<string, unknown>): string | null {
  if (!pattern) return null;
  const href = fillPath(pattern, values);
  return href && isAppRoute(href) ? href : null;
}

function refusal(status: number, body: unknown, what: string): DomainError {
  const e = apiError(body);
  if (status === 404) return notFound(what, e?.message ?? 'not found');
  if (status === 403) return forbidden(what, e?.message ?? 'not permitted');
  if (status === 401) return new DomainError('authentication', 'session_ended', 'Your session has ended. Sign in again.');
  return new DomainError(status >= 500 ? 'internal' : 'validation', e?.code ?? 'object_read_failed', e?.message ?? `Could not read the ${what}`);
}

export async function get(ctx: CardContext, path: string, query?: Record<string, unknown>) {
  return ctx.runner.call(ctx.principal, ctx.scope, { method: 'GET', path, ...(query ? { query } : {}) });
}

export const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * Governed routes that apply directly for some objects: an admin revoking someone's personal MCP connection
 * deletes it at once (204); only shared connections and templates are proposals.
 */
const APPLIES_DIRECTLY: Record<string, (current: Record<string, unknown> | null) => boolean> = {
  'mcp.delete_connection': (current) => typeof current?.['ownerUserId'] === 'string' || current?.['kind'] === 'PERSONAL',
};

/** Read the object as the user, through its own GET route. 404 / 403 end the card: the user cannot act on what they cannot see. */
export async function snapshotObject(ctx: CardContext, capability: Capability, split: SplitArgs): Promise<ObjectSnapshot> {
  if (capability.path.startsWith('/v1/tool-calls/:id')) return toolCallSnapshot(ctx, split);
  const read = objectReadCapability(capability);
  const create = createsGovernedObject(capability);
  let kind = create ? readKind(read) : (capability.approvalKind ?? readKind(read));
  let current: Record<string, unknown> | null = null;
  let id: string | null = null;
  let readParams: Record<string, unknown> = {};
  const own = new Set<unknown>();
  if (read && allowedFor(ctx.principal, read)) {
    readParams = paramsFor(read, capability, split.params);
    const path = fillPath(read.path, readParams);
    if (path) {
      const res = await get(ctx, path);
      if (res.status >= 400) throw refusal(res.status, res.body, kind ?? 'object');
      current = record(res.body);
      const lastParam = paramNames(read.path).at(-1);
      id = (lastParam ? (readParams[lastParam] as string | undefined) : undefined) ?? (typeof current?.['id'] === 'string' ? current['id'] : null);
      if (lastParam) own.add(readParams[lastParam]);
    }
  }
  if (!read) {
    // No GET of the object itself (PATCH /v1/users/:id): find it in its list route's rows, as the list page does.
    const found = await fromList(ctx, capability, split);
    if (found) {
      ({ current, id } = found);
      own.add(found.value);
      kind ??= found.kind;
    }
  }
  // A route that applies directly for this object (a personal MCP connection's delete) governs nothing here.
  const direct = APPLIES_DIRECTLY[capability.name]?.(current) === true;
  const approvalId = capability.approvalKind && !create && !direct ? approvalObjectId(capability, split, id) : null;
  let projection: Record<string, unknown> | null = null;
  const descriptor = capability.approvalKind && ctx.approvals?.has(capability.approvalKind) ? ctx.approvals.get(capability.approvalKind) : null;
  if (descriptor && approvalId) {
    try {
      // The checker projection is shown only for an object this user may see (ADR-026), exactly as the service checks.
      await descriptor.assertVisible(ctx.db, ctx.principal, approvalId);
      projection = await descriptor.project(ctx.db, approvalId);
    } catch (err) {
      if (err instanceof DomainError && (err.category === 'not_found' || err.category === 'authorization')) throw err;
      projection = null;
    }
  }
  const names: Record<string, string> = {};
  if (capability.name === 'conversations.run_conversation_tool' && id) Object.assign(names, await conversationTools(ctx, id, split.body?.['toolId']));
  const name = nameOf(current) ?? (typeof projection?.['name'] === 'string' ? projection['name'] : null);
  const objectId = approvalId ?? id;
  const values = { ...split.params, ...readParams, ...(objectId ? { id: objectId } : {}) };
  const href = hrefFor(read?.uiHref, values) ?? hrefFor(capability.uiHref, values);
  own.add(id);
  const context = await pathContext(ctx, capability, split, own);
  return { kind, id: objectId, name, href, current, projection, approvalId, names, context };
}

/**
 * The collection a list-less object lives in, when it is not the path's own parent: an audit incident is listed
 * by the audit store's status (the System screen), not under `/v1/audit`.
 */
const RELATED_LISTS: Record<string, string> = { '/v1/audit/incidents': '/v1/audit/store' };

/** Every row a read lists: its list rows and every array it carries (a team's members, an agent's prompt versions). */
function candidateRows(body: unknown): Array<Record<string, unknown>> {
  const out = new Set<unknown>(rowsOf(body) ?? []);
  const o = record(body);
  if (o) for (const v of Object.values(o)) if (Array.isArray(v)) v.forEach((x) => out.add(x));
  return [...out].flatMap((r) => (record(r) ? [r as Record<string, unknown>] : []));
}

/** A row is the object when its id, its own field of the parameter's name, or a direct child's (`submission.recordId`) matches. */
function rowMatches(row: Record<string, unknown>, param: string, value: string): boolean {
  if (row['id'] === value) return true;
  if (param === 'id') return false;
  if (row[param] === value) return true;
  return Object.values(row).some((v) => record(v)?.[param] === value);
}

/**
 * The object from the list route of its collection (`GET /v1/users` for `/v1/users/:id`), when the user may use it,
 * else from the nearest read above it that lists it (a team's members, an agent's prompt versions, a channel's
 * template drafts). The path parameter is matched against the row's `id` or its own field of that name
 * (`providerId` for SSO providers, addressed by slug); the returned id is the row's `id`.
 */
async function fromList(ctx: CardContext, capability: Capability, split: SplitArgs): Promise<{ current: Record<string, unknown>; id: string; kind: string; value: string } | null> {
  const match = /^(.*)\/:(\w+)(?:\/[a-z][a-z-]*)*$/.exec(capability.path);
  if (!match) return null;
  const [, collection, param] = match as unknown as [string, string, string];
  const value = split.params[param];
  if (typeof value !== 'string') return null;
  if (collection === '/v1/webhook-deliveries') return webhookDelivery(ctx, value);
  const kind = singular(collection.split('/').at(-1) ?? 'object');
  let source = RELATED_LISTS[collection] ?? collection;
  const exact = source === collection;
  const segments = source.split('/');
  while (!getAt(segments.join('/')) && segments.length > 3) segments.pop();
  source = segments.join('/');
  const list = getAt(source);
  if (!list || !allowedFor(ctx.principal, list)) return null;
  const path = fillPath(list.path, paramsFor(list, capability, split.params));
  if (!path) return null;
  const res = await get(ctx, path);
  if (res.status >= 400) return null;
  const row = candidateRows(res.body).find((r) => rowMatches(r, param, value));
  if (!row) {
    // The collection's own list does not have it: it does not exist (or not for this user). A read above it that
    // does not list it identifies nothing.
    if (exact && source === collection) throw notFound(kind, value);
    return null;
  }
  return { current: row, id: typeof row['id'] === 'string' ? row['id'] : value, kind, value };
}

/** A webhook delivery (`/v1/webhook-deliveries/:id`): in one of the user's webhooks' delivery lists, as the Webhooks page shows them. */
async function webhookDelivery(ctx: CardContext, id: string): Promise<{ current: Record<string, unknown>; id: string; kind: string; value: string } | null> {
  const list = capabilityByName('webhooks.list_webhooks');
  const deliveries = capabilityByName('webhooks.list_deliveries');
  if (!list || !deliveries || !allowedFor(ctx.principal, list) || !allowedFor(ctx.principal, deliveries)) return null;
  const res = await get(ctx, '/v1/webhooks');
  if (res.status >= 400) return null;
  for (const hook of candidateRows(res.body).slice(0, 25)) {
    if (typeof hook['id'] !== 'string') continue;
    const path = fillPath(deliveries.path, { id: hook['id'] });
    if (!path) continue;
    const r = await get(ctx, path);
    const row = r.status < 400 ? candidateRows(r.body).find((d) => d['id'] === id) : undefined;
    if (row) return { current: { ...row, webhook: nameOf(hook) ?? hook['id'] }, id, kind: 'webhook_delivery', value: id };
  }
  return null;
}

/**
 * The objects a path names besides the one the card acts on, each read as the user: the parameter's own prefix
 * route (`/v1/teams/:id` for the team of `/v1/teams/:id/members/:userId`), else a name the user may read.
 */
async function pathContext(ctx: CardContext, capability: Capability, split: SplitArgs, own: ReadonlySet<unknown>): Promise<CardChange[]> {
  const params = paramNames(capability.path);
  if (params.length < 2) return [];
  const rows: CardChange[] = [];
  const unresolved: Array<[string, string]> = [];
  for (const param of params) {
    const value = split.params[param];
    if (typeof value !== 'string' || own.has(value)) continue;
    const prefix = capability.path.slice(0, capability.path.indexOf(`:${param}`) + param.length + 1);
    const read = getAt(prefix);
    if (read && prefix !== capability.path && allowedFor(ctx.principal, read)) {
      const path = fillPath(read.path, paramsFor(read, capability, split.params));
      const res = path ? await get(ctx, path) : null;
      // An object the path names that does not exist ends the card; one this user may not read stays unnamed.
      if (res?.status === 404) throw refusal(res.status, res.body, readKind(read) ?? 'object');
      const name = res && res.status < 400 ? nameOf(res.body) : null;
      if (name) {
        rows.push({ label: label(readKind(read) ?? param), before: null, after: name });
        continue;
      }
    }
    unresolved.push([param, value]);
  }
  if (unresolved.length) {
    const names = await resolveNames(ctx.db, ctx.principal, unresolved.map(([, v]) => v));
    for (const [param, value] of unresolved) if (names.has(value)) rows.push({ label: label(param), before: null, after: names.get(value)! });
  }
  return rows;
}

/**
 * A sensitive tool call the AI agent is waiting on (`/v1/tool-calls/:id/…`): there is no GET of a tool call, so the
 * call is found by id and shown only through its conversation, read as the user (a conversation they cannot see
 * ends the card, exactly as the route's own access check would). The card shows the tool, its arguments, the
 * conversation and the customer; the hash covers the call's status and arguments.
 */
async function toolCallSnapshot(ctx: CardContext, split: SplitArgs): Promise<ObjectSnapshot> {
  const id = split.params['id'];
  const [row] =
    typeof id === 'string' && UUID.test(id)
      ? await ctx.db
          .select({ conversationId: toolCalls.conversationId, status: toolCalls.status, toolName: toolCalls.toolName, args: toolCalls.argsSanitized, argsHash: toolCalls.argsHash, reason: toolCalls.confirmationReason })
          .from(toolCalls)
          .where(eq(toolCalls.id, id))
      : [];
  if (!row?.conversationId) throw notFound('tool_call', String(id));
  const conversation = capabilityByName('conversations.get_conversation')!;
  if (!allowedFor(ctx.principal, conversation)) throw forbidden(conversation.permissions.list.join('+'), 'reading the conversation this tool call belongs to needs conversations.read');
  const res = await get(ctx, fillPath(conversation.path, { id: row.conversationId })!);
  if (res.status >= 400) throw refusal(res.status, res.body, 'tool call');
  const c = record(res.body) ?? {};
  const displayId = typeof c['displayId'] === 'string' ? c['displayId'] : row.conversationId;
  const customer = typeof record(c['customer'])?.['name'] === 'string' ? (record(c['customer'])!['name'] as string) : null;
  return {
    kind: 'tool_call',
    id: id as string,
    name: `${row.toolName} · ${displayId}`,
    href: hrefFor(conversation.uiHref, { id: row.conversationId }),
    current: { status: row.status, toolName: row.toolName, args: row.args, argsHash: row.argsHash, reason: row.reason, conversation: displayId, customer },
    projection: null,
    approvalId: null,
    names: {},
    context: [],
  };
}

/** The tools a person may run in a conversation (`GET /v1/conversations/:id/tools`, as the user): a tool id the card names must be one of them. */
async function conversationTools(ctx: CardContext, conversationId: string, toolId: unknown): Promise<Record<string, string>> {
  const list = capabilityByName('conversations.list_conversation_tools');
  if (!list || !allowedFor(ctx.principal, list)) return {};
  const res = await get(ctx, fillPath(list.path, { id: conversationId })!);
  if (res.status >= 400) return {};
  const available = ((record(res.body)?.['available'] as Array<{ id?: unknown; name?: unknown; connection?: unknown }> | undefined) ?? []).filter((t) => typeof t.id === 'string');
  if (typeof toolId === 'string' && !available.some((t) => t.id === toolId)) {
    throw new DomainError('validation', 'tool_not_available', 'That tool is not one you can run in this conversation: read conversations.list_conversation_tools and use one of its tools.');
  }
  return Object.fromEntries(available.map((t) => [t.id as string, `${String(t.name)}${typeof t.connection === 'string' ? ` (${t.connection})` : ''}`]));
}
