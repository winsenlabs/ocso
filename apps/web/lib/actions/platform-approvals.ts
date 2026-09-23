'use server';

import { refresh } from 'next/cache';
import { Permission } from '@ocso/auth';
import { z } from 'zod';
import { ProposedSchema } from '@/components/approvals/lib/schemas';
import { api } from '../api/client';
import { ApiError, describeApiError } from '../api/errors';
import { getSession } from '../session';

/**
 * Lifecycle writes of the platform objects under maker–checker (PM/research/11 §4): activate (and resume) and
 * delete are always proposals — the screen calls them again with the maker's `approval` from the submit
 * modal; stop (disable) is immediate. One set of server actions for every platform kind, bound per object.
 */

export type PlatformKind =
  | 'channel'
  | 'model_provider'
  | 'model_profile'
  | 'model_pricing'
  | 'mcp_connection'
  | 'notification_destination'
  | 'webhook_subscription'
  | 'sso_provider';

export type LifecycleResult = { ok: true; data: { proposalId: string; title: string } | null } | { ok: false; message: string; code?: string | undefined };

const Approval = z.union([z.object({ checkerId: z.uuid(), reason: z.string().trim().min(3).max(500) }), z.object({ bootstrap: z.literal(true), reason: z.string().trim().min(3).max(500).optional() })]);
type ApprovalChoice = z.input<typeof Approval>;

const enc = encodeURIComponent;
type Call = { method: 'POST' | 'PATCH' | 'DELETE'; path: string; body: Record<string, unknown> };

const ROUTES: Record<PlatformKind, { permission: Permission; activate: (ref: string) => Call; stop?: (ref: string) => Call; remove: (ref: string) => Call }> = {
  channel: {
    permission: Permission.CHANNELS_MANAGE,
    activate: (r) => ({ method: 'PATCH', path: `/v1/channels/${enc(r)}`, body: { status: 'ACTIVE' } }),
    stop: (r) => ({ method: 'PATCH', path: `/v1/channels/${enc(r)}`, body: { status: 'DISABLED' } }),
    remove: (r) => ({ method: 'DELETE', path: `/v1/channels/${enc(r)}`, body: {} }),
  },
  model_provider: {
    permission: Permission.PROVIDERS_MANAGE,
    activate: (r) => ({ method: 'PATCH', path: `/v1/model-providers/${enc(r)}`, body: { enabled: true } }),
    stop: (r) => ({ method: 'PATCH', path: `/v1/model-providers/${enc(r)}`, body: { enabled: false } }),
    remove: (r) => ({ method: 'DELETE', path: `/v1/model-providers/${enc(r)}`, body: {} }),
  },
  model_profile: {
    permission: Permission.MODEL_PROFILES_MANAGE,
    activate: (r) => ({ method: 'POST', path: `/v1/model-profiles/${enc(r)}/activate`, body: {} }),
    remove: (r) => ({ method: 'DELETE', path: `/v1/model-profiles/${enc(r)}`, body: {} }),
  },
  model_pricing: {
    permission: Permission.PRICING_MANAGE,
    activate: (r) => ({ method: 'POST', path: `/v1/model-pricing/${enc(r)}/activate`, body: {} }),
    remove: (r) => ({ method: 'DELETE', path: `/v1/model-pricing/${enc(r)}`, body: {} }),
  },
  mcp_connection: {
    permission: Permission.MCP_MANAGE,
    activate: (r) => ({ method: 'POST', path: `/v1/mcp/connections/${enc(r)}/enable`, body: {} }),
    stop: (r) => ({ method: 'POST', path: `/v1/mcp/connections/${enc(r)}/disable`, body: {} }),
    remove: (r) => ({ method: 'DELETE', path: `/v1/mcp/connections/${enc(r)}`, body: {} }),
  },
  notification_destination: {
    permission: Permission.NOTIFICATION_DESTINATIONS_MANAGE,
    activate: (r) => ({ method: 'PATCH', path: `/v1/notification-destinations/${enc(r)}`, body: { enabled: true } }),
    stop: (r) => ({ method: 'PATCH', path: `/v1/notification-destinations/${enc(r)}`, body: { enabled: false } }),
    remove: (r) => ({ method: 'DELETE', path: `/v1/notification-destinations/${enc(r)}`, body: {} }),
  },
  webhook_subscription: {
    permission: Permission.WEBHOOKS_MANAGE,
    activate: (r) => ({ method: 'PATCH', path: `/v1/webhooks/${enc(r)}`, body: { enabled: true } }),
    stop: (r) => ({ method: 'PATCH', path: `/v1/webhooks/${enc(r)}`, body: { enabled: false } }),
    remove: (r) => ({ method: 'DELETE', path: `/v1/webhooks/${enc(r)}`, body: {} }),
  },
  sso_provider: {
    permission: Permission.DEPLOYMENT_SETTINGS_MANAGE,
    activate: (r) => ({ method: 'POST', path: `/v1/settings/sso-providers/${enc(r)}/status`, body: { status: 'ACTIVE' } }),
    stop: (r) => ({ method: 'POST', path: `/v1/settings/sso-providers/${enc(r)}/status`, body: { status: 'DISABLED' } }),
    remove: (r) => ({ method: 'DELETE', path: `/v1/settings/sso-providers/${enc(r)}`, body: {} }),
  },
};

const Ref = z.string().min(1).max(200).regex(/^[A-Za-z0-9-]+$/);
const Answer = z.union([ProposedSchema, z.unknown()]);

async function call(kind: PlatformKind, ref: string, which: 'activate' | 'stop' | 'remove', approval?: ApprovalChoice): Promise<LifecycleResult> {
  const route = ROUTES[kind];
  const build = which === 'stop' ? route.stop : route[which];
  if (!build || !Ref.safeParse(ref).success) return { ok: false, message: 'Unknown object.' };
  const choice = approval === undefined ? undefined : Approval.safeParse(approval);
  if (choice && !choice.success) return { ok: false, message: choice.error.issues.map((i) => i.message).join('; ') };
  const session = await getSession();
  if (!session) return { ok: false, message: 'Your session has ended. Sign in again.' };
  if (!session.permissions.has(route.permission)) return { ok: false, message: 'Your role cannot change this.' };
  const { method, path, body } = build(ref);
  const send = { ...body, ...(choice?.success ? { approval: choice.data } : {}) };
  try {
    const res = method === 'DELETE' ? await api.delete(path, send, Answer) : method === 'PATCH' ? await api.patch(path, send, Answer) : await api.post(path, send, Answer);
    refresh();
    const proposed = ProposedSchema.safeParse(res);
    return { ok: true, data: proposed.success ? { proposalId: proposed.data.proposal.id, title: proposed.data.proposal.title } : null };
  } catch (err) {
    return { ok: false, message: describeApiError(err), code: err instanceof ApiError ? err.code : undefined };
  }
}

/** Activate or resume: always a proposal (409 approval_required without `approval`). */
export async function platformActivateAction(kind: PlatformKind, ref: string, approval?: ApprovalChoice): Promise<LifecycleResult> {
  return call(kind, ref, 'activate', approval);
}

/** Disable: a stop action, immediate and never gated. */
export async function platformStopAction(kind: PlatformKind, ref: string): Promise<LifecycleResult> {
  return call(kind, ref, 'stop');
}

/** Delete: always a proposal. */
export async function platformDeleteAction(kind: PlatformKind, ref: string, approval?: ApprovalChoice): Promise<LifecycleResult> {
  return call(kind, ref, 'remove', approval);
}
