'use server';

import { refresh } from 'next/cache';
import { Permission } from '@ocso/auth';
import { z } from 'zod';
import { describeApiError } from '../api/errors';
import {
  CONFIRMATION_POLICIES,
  HUMAN_ROLES,
  RISK_CLASSES,
  approveConnection,
  beginOAuth,
  checkHealth,
  classifyTools,
  createConnection,
  createPersonalConnection,
  deleteConnection,
  disableConnection,
  discover,
  enableConnection,
  rediscover,
  setHeaderAuth,
  type Discovery,
  type HealthOutcome,
  type McpArea,
} from '../api/mcp';
import { getSession } from '../session';
import type { ActionResult } from './models';

/** What the wizard needs after a discovery: the connection it now shows and a one-line outcome. */
export interface DiscoverySummary {
  connectionId: string;
  outcome: 'DISCOVERED' | 'AUTH_REQUIRED' | 'FAILED';
  message: string;
}

const Id = z.uuid();
const Area = z.enum(['connections', 'personal']);
const permissionFor = (area: McpArea) => (area === 'personal' ? Permission.MCP_CONNECT_PERSONAL : Permission.MCP_MANAGE);

async function denied(permission: Permission): Promise<string | null> {
  const session = await getSession();
  if (!session) return 'Your session has ended. Sign in again.';
  return session.permissions.has(permission) ? null : 'Your role cannot change this MCP connection.';
}

async function run<I, T>(schema: z.ZodType<I>, raw: unknown, permission: (input: I) => Permission, call: (input: I) => Promise<T>): Promise<ActionResult<T>> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ') };
  const problem = await denied(permission(parsed.data));
  if (problem) return { ok: false, message: problem };
  try {
    const data = await call(parsed.data);
    refresh();
    return { ok: true, data };
  } catch (err) {
    refresh(); // failures still change status / lastError on the connection
    return { ok: false, message: describeApiError(err) };
  }
}

function summarize(d: Discovery): DiscoverySummary {
  if (d.outcome === 'AUTH_REQUIRED') {
    return { connectionId: d.connection.id, outcome: 'AUTH_REQUIRED', message: `The server requires authentication (${d.authRequired.reason.replace(/_/g, ' ')}).` };
  }
  const t = d.tools;
  const parts = [`${t.added} new`, `${t.changed} changed`, `${t.removed} removed`].join(', ');
  const warn = d.warnings.length ? ` Warnings: ${d.warnings.join('; ')}` : '';
  return { connectionId: d.connection.id, outcome: 'DISCOVERED', message: `Discovered ${t.total} tools (${parts}).${warn}` };
}

async function discoverSafely(id: string, area: McpArea): Promise<DiscoverySummary> {
  try {
    return summarize(await discover(id, area));
  } catch (err) {
    return { connectionId: id, outcome: 'FAILED', message: describeApiError(err) };
  }
}

const CreateInput = z.object({
  name: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/, 'lower-case letters, digits and dashes (2–40 characters)'),
  description: z.string().trim().max(500),
  url: z.string().trim().min(1, 'Enter the MCP server URL').max(2_048),
  network: z.enum(['PUBLIC', 'INTERNAL']),
  scope: z.enum(['SHARED', 'USER']),
});

/** Wizard steps 1–2: save the draft (egress-checked by the API), then discover. */
export async function createAndDiscoverAction(input: z.input<typeof CreateInput>): Promise<ActionResult<DiscoverySummary>> {
  return run(CreateInput, input, () => Permission.MCP_MANAGE, async ({ description, ...rest }) => {
    const created = await createConnection({ ...rest, ...(description ? { description } : {}) });
    return discoverSafely(created.id, 'connections');
  });
}

export async function discoverAction(id: string, area: McpArea): Promise<ActionResult<DiscoverySummary>> {
  return run(z.object({ id: Id, area: Area }), { id, area }, (i) => permissionFor(i.area), async (i) => {
    const d = await discover(i.id, i.area);
    return summarize(d);
  });
}

/** Re-read the server's tool list; drifted tools lose their approval until re-approved. */
export async function rediscoverAction(id: string): Promise<ActionResult<DiscoverySummary>> {
  return run(Id, id, () => Permission.MCP_MANAGE, async (cid) => summarize(await rediscover(cid)));
}

const HeaderInput = z.object({
  id: Id,
  area: Area,
  headerName: z.string().trim().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/, 'a valid HTTP header name'),
  token: z.string().trim().min(1, 'Enter the credential').max(8_000),
});

/** Static header credential (stored in the secret store), then discovery with it. */
export async function headerAuthAction(id: string, area: McpArea, headerName: string, token: string): Promise<ActionResult<DiscoverySummary>> {
  return run(HeaderInput, { id, area, headerName, token }, (i) => permissionFor(i.area), async (i) =>
    summarize(await setHeaderAuth(i.id, { headerName: i.headerName, token: i.token }, i.area)),
  );
}

const OAuthInput = z.object({
  id: Id,
  area: Area,
  clientId: z.string().trim().max(512),
  clientSecret: z.string().max(4_096),
  scopes: z.string().trim().max(2_000),
});

/** Starts the OAuth 2.1 flow; the browser then navigates to the authorization URL. */
export async function beginOAuthAction(id: string, area: McpArea, options: { clientId: string; clientSecret: string; scopes: string }): Promise<ActionResult<{ authorizationUrl: string }>> {
  return run(OAuthInput, { id, area, ...options }, (i) => permissionFor(i.area), async (i) => {
    const scopes = i.scopes.split(/[\s,]+/).filter(Boolean);
    const begun = await beginOAuth(
      i.id,
      { ...(i.clientId ? { clientId: i.clientId } : {}), ...(i.clientId && i.clientSecret ? { clientSecret: i.clientSecret } : {}), ...(scopes.length ? { scopes } : {}) },
      i.area,
    );
    const url = new URL(begun.authorizationUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('unexpected authorization URL');
    return { authorizationUrl: url.href };
  });
}

const ClassifyInput = z.object({
  id: Id,
  tools: z
    .array(z.object({ toolId: Id, riskClass: z.enum(RISK_CLASSES), approved: z.boolean(), humanRoles: z.array(z.enum(HUMAN_ROLES)).max(3) }))
    .min(1, 'There are no tools to classify')
    .max(500),
});

export async function classifyToolsAction(id: string, tools: z.input<typeof ClassifyInput>['tools']): Promise<ActionResult<{ approved: number }>> {
  return run(ClassifyInput, { id, tools }, () => Permission.MCP_MANAGE, async (i) => {
    const saved = await classifyTools(i.id, i.tools);
    return { approved: saved.filter((t) => t.approved && !t.removedAt).length };
  });
}

const ApproveInput = z.object({
  id: Id,
  allowedAgentIds: z.union([z.literal('*'), z.array(Id).max(200)]),
  confirmationPolicy: z.enum(CONFIRMATION_POLICIES),
  sendCustomerClaims: z.boolean(),
  healthCheckSeconds: z.number().int().min(15, 'at least 15 seconds').max(3_600, 'at most 3600 seconds'),
});

export async function approveConnectionAction(input: z.input<typeof ApproveInput>): Promise<ActionResult<{ status: string }>> {
  return run(ApproveInput, input, () => Permission.MCP_MANAGE, async ({ id, ...approval }) => {
    const c = await approveConnection(id, approval);
    return { status: c.status };
  });
}

export async function setConnectionEnabledAction(id: string, enabled: boolean): Promise<ActionResult<{ status: string }>> {
  return run(z.object({ id: Id, enabled: z.boolean() }), { id, enabled }, () => Permission.MCP_MANAGE, async (i) => {
    const c = await (i.enabled ? enableConnection(i.id) : disableConnection(i.id));
    return { status: c.status };
  });
}

/** Deletes the connection and revokes its stored credentials (and a template's personal copies). */
export async function deleteConnectionAction(id: string, area: McpArea): Promise<ActionResult> {
  return run(z.object({ id: Id, area: Area }), { id, area }, (i) => permissionFor(i.area), async (i) => {
    await deleteConnection(i.id, i.area);
    return null;
  });
}

export async function checkHealthAction(id: string, area: McpArea): Promise<ActionResult<HealthOutcome>> {
  return run(z.object({ id: Id, area: Area }), { id, area }, (i) => permissionFor(i.area), (i) => checkHealth(i.id, i.area));
}

/** "Connect my account" to an admin-published template: personal copy, then discovery. */
export async function connectTemplateAction(templateId: string): Promise<ActionResult<DiscoverySummary>> {
  return run(Id, templateId, () => Permission.MCP_CONNECT_PERSONAL, async (tid) => {
    const created = await createPersonalConnection(tid);
    return discoverSafely(created.id, 'personal');
  });
}
