import type { APIRequestContext } from '@playwright/test';

/**
 * Platform objects in spec setups go live the way a deployment takes them live (PM/research/11 §4): the
 * Tech admin creates a draft (a disabled provider, a DRAFT channel) and a second person — a Head, who holds
 * approvals.check.platform and approvals.check.channels — approves its activation. Never a bootstrap: the
 * shared e2e database always has another checker.
 */
export interface Checker {
  id: string;
  token: string;
}

async function call<T>(api: APIRequestContext, method: string, path: string, token: string, data?: unknown): Promise<T> {
  const res = await api.fetch(path, { method, headers: { authorization: `Bearer ${token}` }, ...(data !== undefined ? { data } : {}) });
  if (res.status() >= 300) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  return (res.status() === 204 ? {} : await res.json()) as T;
}

/** Submit (as the maker) the proposal an approvable write opened, then approve it as the checker. */
export async function approveOver(api: APIRequestContext, makerToken: string, checker: Checker, write: { method: string; path: string; body: Record<string, unknown> }): Promise<void> {
  const { proposal } = await call<{ proposal: { id: string; contentHash: string } }>(api, write.method, write.path, makerToken, {
    ...write.body,
    approval: { checkerId: checker.id, reason: 'E2E setup: platform object' },
  });
  await call(api, 'POST', `/v1/approvals/${proposal.id}/decision`, checker.token, { decision: 'APPROVE', reason: 'E2E setup: reviewed', contentHash: proposal.contentHash });
}

/** A model provider created as a draft and enabled by the checker's approval; returns its id. */
export async function approvedProvider(api: APIRequestContext, adminToken: string, checker: Checker, body: Record<string, unknown>): Promise<string> {
  const { id } = await call<{ id: string }>(api, 'POST', '/v1/model-providers', adminToken, { ...body, enabled: false });
  await approveOver(api, adminToken, checker, { method: 'PATCH', path: `/v1/model-providers/${id}`, body: { enabled: true } });
  return id;
}

/** A channel created as a draft and activated by the checker's approval; returns what the create answered. */
export async function approvedChannel<T extends { id: string }>(api: APIRequestContext, adminToken: string, checker: Checker, body: Record<string, unknown>): Promise<T> {
  const created = await call<T>(api, 'POST', '/v1/channels', adminToken, { ...body, status: 'DRAFT' });
  await approveOver(api, adminToken, checker, { method: 'PATCH', path: `/v1/channels/${created.id}`, body: { status: 'ACTIVE' } });
  return created;
}

/** The id of the user a token belongs to. */
export async function userIdOf(api: APIRequestContext, token: string): Promise<string> {
  return (await call<{ id: string }>(api, 'GET', '/v1/auth/me', token)).id;
}

/**
 * A model profile created as a draft and approved for use by the checker; returns its id. Agents go live
 * (and routers classify) only on approved profiles (approvals.check.platform).
 */
export async function approvedProfile(api: APIRequestContext, adminToken: string, checker: Checker, body: Record<string, unknown>): Promise<string> {
  const { id } = await call<{ id: string }>(api, 'POST', '/v1/model-profiles', adminToken, body);
  await approveOver(api, adminToken, checker, { method: 'POST', path: `/v1/model-profiles/${id}/activate`, body: {} });
  return id;
}
