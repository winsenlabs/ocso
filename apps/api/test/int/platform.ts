import { randomBytes } from 'node:crypto';
import { addUserWithPassword, type ApiHarness } from './harness.js';

/**
 * Platform objects in API tests go live the way a deployment takes them live (PM/research/11 §4): the maker
 * proposes, a second person approves. The checker is a Head — Heads hold approvals.check.platform and
 * approvals.check.channels — created with a password on first use.
 */
export interface Checker {
  id: string;
  token: string;
}

export async function platformChecker(h: ApiHarness, name = 'Priya Checker'): Promise<Checker> {
  const email = `checker-${randomBytes(4).toString('hex')}@ocso.test`;
  const password = 'checker password 1234';
  const id = await addUserWithPassword(h, { email, name, role: 'HEAD', password });
  return { id, token: await h.loginAs(email, password) };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** Approve an open proposal as the named checker (with the hashes they are shown). */
export async function approveProposal(h: ApiHarness, checker: Checker, proposal: { id: string; contentHash: string }): Promise<Record<string, unknown>> {
  const res = await h.http().post(`/v1/approvals/${proposal.id}/decision`).set(auth(checker.token)).send({ decision: 'APPROVE', reason: 'Reviewed in test', contentHash: proposal.contentHash });
  if (res.status !== 200 && res.status !== 201) throw new Error(`decision → ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as Record<string, unknown>;
}

/** POST /v1/approvals as the maker, naming the checker, then approve it. */
export async function approveOverHttp(
  h: ApiHarness,
  makerToken: string,
  checker: Checker,
  target: { objectKind: string; objectId: string; action: 'ACTIVATE' | 'UPDATE' | 'DELETE'; payload?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const res = await h.http().post('/v1/approvals').set(auth(makerToken)).send({ ...target, checkerId: checker.id, reason: 'Test change' });
  if (res.status !== 201) throw new Error(`submit ${target.objectKind} ${target.action} → ${res.status} ${JSON.stringify(res.body)}`);
  return approveProposal(h, checker, res.body as { id: string; contentHash: string });
}

/** Create a channel (a draft) and take it live through an approval; returns the created view. */
export async function liveChannel<T extends { id: string }>(h: ApiHarness, adminToken: string, checker: Checker, body: Record<string, unknown>): Promise<T> {
  const res = await h.http().post('/v1/channels').set(auth(adminToken)).send({ ...body, status: 'DRAFT' });
  if (res.status !== 201) throw new Error(`POST /v1/channels → ${res.status} ${JSON.stringify(res.body)}`);
  await approveOverHttp(h, adminToken, checker, { objectKind: 'channel', objectId: res.body.id, action: 'ACTIVATE' });
  return { ...(res.body as T), status: 'ACTIVE' };
}

/** Create a model provider (a disabled draft) and enable it through an approval. */
export async function liveProvider<T extends { id: string }>(h: ApiHarness, adminToken: string, checker: Checker, body: Record<string, unknown>): Promise<T> {
  const res = await h.http().post('/v1/model-providers').set(auth(adminToken)).send({ ...body, enabled: false });
  if (res.status !== 201) throw new Error(`POST /v1/model-providers → ${res.status} ${JSON.stringify(res.body)}`);
  await approveOverHttp(h, adminToken, checker, { objectKind: 'model_provider', objectId: res.body.id, action: 'ACTIVATE' });
  return { ...(res.body as T), enabled: true };
}

/**
 * The same approval through the application services, for tests that drive services without the HTTP app:
 * a Head checker is created in the database on first use; `finish` completes a deferred activation (the
 * worker's job) when the kind defers.
 */
export async function approveInDb(
  db: import('@ocso/db').Db,
  maker: import('@ocso/application').ActorContext,
  target: { objectKind: string; objectId: string; action: 'ACTIVATE' | 'UPDATE' | 'DELETE'; payload?: Record<string, unknown> },
  platform: import('@ocso/application').PlatformApprovalDeps = {},
): Promise<{ id: string; status: string }> {
  const { ApprovalDecisionService, ApprovalService, createApprovalRegistry } = await import('@ocso/application');
  const { users, uuidv7 } = await import('@ocso/db');
  const registry = createApprovalRegistry({ platform });
  const checkerId = uuidv7();
  await db.insert(users).values({ id: checkerId, email: `checker-${checkerId.slice(-8)}@ocso.test`, name: 'Db Checker', role: 'HEAD' });
  const checker = { principal: { userId: checkerId, role: 'HEAD' as const, displayName: 'Db Checker', teamIds: [], via: 'UI' as const }, correlationId: 'db-checker' };
  const submitted = await new ApprovalService(db, registry).submit(maker, { ...target, checkerId, reason: 'Test change' });
  const decisions = new ApprovalDecisionService(db, registry);
  const decided = await decisions.decide(checker, submitted.id, { decision: 'APPROVE', reason: 'Reviewed', contentHash: submitted.contentHash });
  if (decided.activating) await decisions.finishActivation(checker, decided.id);
  return { id: decided.id, status: decided.status };
}
