import type { APIRequestContext } from '@playwright/test';

/**
 * Take an agent live in a spec's setup through a real second-person approval
 * (PM/research/11 §4): a checker Head is created in the agent's owning team and
 * approves the maker's proposal. Bootstrap (self-approval) is only for a
 * deployment with no other checker anywhere — never the case once several
 * specs share the e2e database.
 */
export async function goLiveApproved(
  api: APIRequestContext,
  o: { adminToken: string; makerToken: string; agentId: string; ownerTeamId: string; checker: { name: string; email: string; password: string } },
): Promise<{ checkerId: string; checkerToken: string }> {
  const call = async <T>(method: string, path: string, token: string | null, data?: unknown): Promise<T> => {
    const res = await api.fetch(path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(data !== undefined ? { data } : {}) });
    if (res.status() >= 300) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
    return (res.status() === 204 ? {} : await res.json()) as T;
  };
  const checker = await call<{ id: string }>('POST', '/v1/users', o.adminToken, {
    name: o.checker.name,
    email: o.checker.email,
    role: 'HEAD',
    password: o.checker.password,
    teamIds: [o.ownerTeamId],
    languages: [],
    maxConcurrent: 5,
  });
  const { proposal } = await call<{ proposal: { id: string; contentHash: string } }>('POST', `/v1/agents/${o.agentId}/status`, o.makerToken, {
    status: 'LIVE',
    approval: { checkerId: checker.id, reason: 'E2E setup: ready for customers' },
  });
  const { token } = await call<{ token: string }>('POST', '/v1/auth/login', null, { email: o.checker.email, password: o.checker.password });
  await call('POST', `/v1/approvals/${proposal.id}/decision`, token, { decision: 'APPROVE', reason: 'E2E setup: reviewed', contentHash: proposal.contentHash });
  // The checker, for later setup changes to the live agent (tool grants, escalation rules: COVERAGE-BUSINESS).
  return { checkerId: checker.id, checkerToken: token };
}
