import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completeSetup, startApi, type ApiHarness } from './harness.js';
import { createTeam, setTeams } from './teams.js';

let h: ApiHarness;
let admin: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const tokens: Record<'a' | 'b', string> = { a: '', b: '' };
const agents: Record<'a' | 'b', string> = { a: '', b: '' };

beforeAll(async () => {
  h = await startApi();
  admin = await completeSetup(h);
  for (const k of ['a', 'b'] as const) {
    const id = (await h.http().post('/v1/users').set(auth(admin)).send({ email: `lead-${k}@ocso.test`, name: `Lead ${k.toUpperCase()}`, role: 'CS_LEAD', password: 'a password 12345' }).expect(201)).body.id as string;
    tokens[k] = await h.loginAs(`lead-${k}@ocso.test`, 'a password 12345');
    const team = await createTeam(h, tokens[k], `Team ${k.toUpperCase()}`);
    await setTeams(h, admin, id, [team]);
    agents[k] = (await h.http().post('/v1/agents').set(auth(tokens[k])).send({ name: `Agent ${k.toUpperCase()}`, purpose: 'support', conversationType: 'SUPPORT', teamIds: [team] }).expect(201)).body.id as string;
  }
});
afterAll(async () => {
  await h?.close();
});

const targets = async (token: string) => {
  const res = await h.http().get('/v1/audit?limit=500').set(auth(token)).expect(200);
  return new Set((res.body as Array<{ targetType: string; targetId: string | null }>).filter((e) => e.targetType === 'agent').map((e) => e.targetId));
};

describe('audit log scope (ADR-026)', () => {
  it("shows a CS Lead their own team's agent changes but not another team's", async () => {
    const a = await targets(tokens.a);
    expect(a.has(agents.a)).toBe(true);
    expect(a.has(agents.b)).toBe(false);
    const b = await targets(tokens.b);
    expect(b.has(agents.b)).toBe(true);
    expect(b.has(agents.a)).toBe(false);
  });

  it('shows the Tech Admin the whole log', async () => {
    const all = await targets(admin);
    expect(all.has(agents.a) && all.has(agents.b)).toBe(true);
  });
});
