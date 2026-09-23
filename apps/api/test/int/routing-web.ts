import { randomBytes } from 'node:crypto';
import type { ApiHarness } from './harness.js';

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/**
 * An ACTIVE web chat channel for routing tests (PM/research/11 §4): made by the
 * admin; when channels are an approval kind it is created as a draft and a Head
 * (approvals.check.channels) approves its activation — never a bootstrap.
 */
export async function activeWebChat(h: ApiHarness, admin: string, checker: { token: string; id: string }, name: string): Promise<{ id: string; publicKey: string }> {
  const body = { kind: 'WEBCHAT', name, settings: {}, secrets: { visitorTokenSecret: randomBytes(32).toString('hex') } };
  const direct = await h.http().post('/v1/channels').set(auth(admin)).send({ ...body, status: 'ACTIVE' });
  if (direct.status === 201) return direct.body;
  const draft = (await h.http().post('/v1/channels').set(auth(admin)).send({ ...body, status: 'DRAFT' }).expect(201)).body;
  const proposal = (await h.http().post('/v1/approvals').set(auth(admin)).send({ objectKind: 'channel', objectId: draft.id, action: 'ACTIVATE', checkerId: checker.id, reason: 'Routing test channel' }).expect(201)).body;
  await h.http().post(`/v1/approvals/${proposal.id}/decision`).set(auth(checker.token)).send({ decision: 'APPROVE', reason: 'Reviewed', contentHash: proposal.contentHash }).expect(200);
  return draft;
}
