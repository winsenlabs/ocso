'use server';

import { refresh } from 'next/cache';
import { Permission } from '@ocso/auth';
import { RouterDefinitionSchema } from '@ocso/domain';
import { z } from 'zod';
import { ProposedSchema } from '@/components/approvals/lib/schemas';
import { api } from '../api/client';
import { ApiError, describeApiError } from '../api/errors';
import {
  activateRouter,
  createRouter,
  deleteRouter,
  disableRouter,
  freezeRouterVersion,
  saveRouterDraft,
  setRouterChannels,
  simulateRouter,
  updateRouter,
  type Simulation,
} from '../api/routers';
import { getSession } from '../session';

/**
 * Router builder actions (PM/research/11 §5.7). The draft, versions and a
 * draft router's channels change directly; activating (or resuming) the
 * newest version and deleting are always proposals; renaming and attaching
 * channels are proposals once the router is approved — the API answers
 * `approval_required` and the screen re-sends with the maker's `approval`.
 * Disabling and detaching are stops. The API is the enforcement point.
 */
export type RouterActionResult<T = null> = { ok: true; data: T } | { ok: false; message: string; code?: string | undefined; problems?: string[] | undefined };
export type Proposed = { proposalId: string; title: string } | null;

const Id = z.uuid();
const Approval = z.union([z.object({ checkerId: Id, reason: z.string().trim().min(3).max(500) }), z.object({ bootstrap: z.literal(true), reason: z.string().trim().min(3).max(500).optional() })]);

async function run<I, T>(permission: Permission, what: string, schema: z.ZodType<I>, raw: unknown, call: (input: I) => Promise<T>, reload = true): Promise<RouterActionResult<T>> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ') };
  const session = await getSession();
  if (!session) return { ok: false, message: 'Your session has ended. Sign in again.' };
  if (!session.permissions.has(permission)) return { ok: false, message: `Your role cannot ${what}.` };
  try {
    const data = await call(parsed.data);
    if (reload) refresh();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, message: describeApiError(err), code: err instanceof ApiError ? err.code : undefined };
  }
}

const proposedOf = (body: unknown): Proposed => {
  const parsed = ProposedSchema.safeParse(body);
  return parsed.success ? { proposalId: parsed.data.proposal.id, title: parsed.data.proposal.title } : null;
};

export async function createRouterAction(input: { name: string; description: string; fallbackQueueId: string }): Promise<RouterActionResult<{ id: string }>> {
  return run(
    Permission.ROUTERS_MANAGE,
    'create routers',
    z.object({ name: z.string().trim().min(1, 'Enter a name').max(120), description: z.string().trim().max(500), fallbackQueueId: z.uuid('Choose the queue everyone goes to by default') }),
    input,
    (i) => createRouter({ name: i.name, description: i.description, definition: { steps: [], rules: [], fallbackQueueId: i.fallbackQueueId, returning: null, timeoutMinutes: 10 } }),
  );
}

/** The draft is inert: saved directly (a rename of an approved router is a proposal, see renameRouterAction). */
export async function saveRouterDraftAction(id: string, definition: unknown): Promise<RouterActionResult<{ id: string }>> {
  return run(Permission.ROUTERS_MANAGE, 'edit routers', z.object({ id: Id, definition: RouterDefinitionSchema }), { id, definition }, (i) => saveRouterDraft(i.id, { definition: i.definition }));
}

export async function freezeRouterVersionAction(id: string, reason: string): Promise<RouterActionResult<{ id: string; version: number }>> {
  return run(Permission.ROUTERS_MANAGE, 'freeze router versions', z.object({ id: Id, reason: z.string().trim().max(500) }), { id, reason }, (i) => freezeRouterVersion(i.id, i.reason));
}

/** Activating (or resuming) the newest version: always a proposal. */
export async function activateRouterAction(id: string, versionId: string, approval?: unknown): Promise<RouterActionResult<Proposed>> {
  if (approval === undefined) return { ok: false, message: 'Activating a router needs approval.', code: 'approval_required' };
  return run(Permission.ROUTERS_MANAGE, 'activate routers', z.object({ id: Id, versionId: Id, approval: Approval }), { id, versionId, approval }, async (i) => proposedOf(await activateRouter(i.id, { versionId: i.versionId, approval: i.approval })));
}

/** Stop: immediate, never gated. */
export async function disableRouterAction(id: string): Promise<RouterActionResult> {
  return run(Permission.ROUTERS_MANAGE, 'disable routers', Id, id, async (i) => {
    await disableRouter(i);
    return null;
  });
}

/** Detaching applies at once; attaching is direct for a draft router and a proposal once it is approved. */
export async function setRouterChannelsAction(id: string, channelIds: string[], approval?: unknown): Promise<RouterActionResult<Proposed>> {
  return run(Permission.ROUTERS_MANAGE, 'change router channels', z.object({ id: Id, channelIds: z.array(Id).max(200), approval: Approval.optional() }), { id, channelIds, approval }, async (i) =>
    proposedOf(await setRouterChannels(i.id, { channelIds: i.channelIds, ...(i.approval ? { approval: i.approval } : {}) })),
  );
}

export async function renameRouterAction(id: string, patch: { name?: string; description?: string }, approval?: unknown): Promise<RouterActionResult<Proposed>> {
  return run(
    Permission.ROUTERS_MANAGE,
    'rename routers',
    z.object({ id: Id, name: z.string().trim().min(1).max(120).optional(), description: z.string().trim().max(500).optional(), approval: Approval.optional() }),
    { id, ...patch, approval },
    async ({ id: rid, approval: a, ...p }) => proposedOf(await updateRouter(rid, { ...p, ...(a ? { approval: a } : {}) })),
  );
}

/** Deleting a router: always a proposal. */
export async function deleteRouterAction(id: string, approval?: unknown): Promise<RouterActionResult<Proposed>> {
  if (approval === undefined) return { ok: false, message: 'Deleting a router needs approval.', code: 'approval_required' };
  return run(Permission.ROUTERS_MANAGE, 'delete routers', z.object({ id: Id, approval: Approval }), { id, approval }, async (i) => proposedOf(await deleteRouter(i.id, { approval: i.approval })));
}

/** Dry run of the draft (or a version): the decision trace, nothing sent. */
export async function simulateRouterAction(id: string, input: { messages: string[]; versionId?: string | undefined; language?: string | undefined }): Promise<RouterActionResult<Simulation>> {
  return run(
    Permission.ROUTERS_READ,
    'simulate routers',
    z.object({ id: Id, messages: z.array(z.string().trim().min(1).max(4_000)).min(1).max(20), versionId: Id.optional(), language: z.string().trim().max(20).optional() }),
    { id, ...input },
    (i) => simulateRouter(i.id, { messages: i.messages, ...(i.versionId ? { versionId: i.versionId } : {}), ...(i.language ? { customer: { language: i.language } } : {}) }),
    false,
  );
}

const Created = z.object({ template: z.object({ id: z.string(), submission: z.object({ recordId: z.string() }).nullable().optional() }).passthrough() }).passthrough();

/**
 * "Create template for <channel>" (PM/research/11 §5.7): drafts a message template carrying the router
 * message's text on that channel (a draft never reaches the provider) and returns its OCSO record id; the
 * builder maps it into the step's `templates` and opens the template's own approval.
 */
export async function draftRouterTemplateAction(channelId: string, input: { name: string; text: string; language: string }): Promise<RouterActionResult<{ templateId: string }>> {
  return run(
    Permission.MESSAGE_TEMPLATES_MANAGE,
    'create message templates',
    z.object({ channelId: Id, name: z.string().trim().regex(/^[a-z0-9_]{1,512}$/, 'template names are lower case letters, digits and _'), text: z.string().trim().min(1).max(1_024), language: z.string().trim().min(2).max(16) }),
    { channelId, ...input },
    async (i) => {
      const res = await api.post(`/v1/channels/${encodeURIComponent(i.channelId)}/templates`, { name: i.name, language: i.language, category: 'UTILITY', body: i.text }, Created);
      return { templateId: res.template.submission?.recordId ?? res.template.id };
    },
    false,
  );
}

/** Submit any approvable object through the generic spine endpoint (a template drafted from the builder). */
export async function submitForApprovalAction(objectKind: string, objectId: string, action: 'CREATE' | 'ACTIVATE', approval?: unknown): Promise<RouterActionResult<Proposed>> {
  if (approval === undefined) return { ok: false, message: 'This needs approval.', code: 'approval_required' };
  return run(
    Permission.APPROVALS_READ,
    'submit changes for approval',
    z.object({ objectKind: z.string().min(1).max(60), objectId: Id, action: z.enum(['CREATE', 'ACTIVATE']), approval: Approval }),
    { objectKind, objectId, action, approval },
    async (i) => {
      const body = { objectKind: i.objectKind, objectId: i.objectId, action: i.action, reason: i.approval.reason ?? 'Router message template', ...('checkerId' in i.approval ? { checkerId: i.approval.checkerId } : { bootstrap: true }) };
      const detail = await api.post('/v1/approvals', body, z.object({ id: z.string(), title: z.string() }).passthrough());
      return { proposalId: detail.id, title: detail.title };
    },
  );
}
