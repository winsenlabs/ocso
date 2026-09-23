import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { completeSetup, startApi, type ApiHarness } from './harness.js';

const SECRET = 'sk-ant-api-INTEGRATION-SECRET-0123456789';
const ROTATED = 'sk-ant-api-INTEGRATION-ROTATED-987654321';
const LEAKS = new RegExp(`${SECRET}|${ROTATED}`);

let h: ApiHarness;
let admin: string;
let lead: string;
let exec: string;
let anthropicId: string;
let devId: string;
let profileId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  process.env['OCSO_ENABLE_DEV_PROVIDERS'] = 'true';
  h = await startApi();
  admin = await completeSetup(h);
  for (const [email, role] of [
    ['lead@ocso.test', 'HEAD'],
    ['exec@ocso.test', 'SERVICE'],
  ] as const) {
    await h.http().post('/v1/users').set(auth(admin)).send({ email, name: role, role, password: `${role} password 1234` }).expect(201);
  }
  lead = await h.loginAs('lead@ocso.test', 'HEAD password 1234');
  exec = await h.loginAs('exec@ocso.test', 'SERVICE password 1234');
});
afterAll(async () => {
  await h?.close();
});

describe('model providers API', () => {
  it('lists provider kinds with form descriptors', async () => {
    const res = await h.http().get('/v1/model-providers/kinds').set(auth(admin)).expect(200);
    const anthropic = res.body.find((k: { kind: string }) => k.kind === 'ANTHROPIC');
    expect(anthropic.credentials).toEqual([expect.objectContaining({ name: 'apiKey', secret: true, required: true })]);
    // Everything the UI shows about a kind comes from its definition.
    expect(anthropic).toMatchObject({ label: 'Anthropic API', mark: 'ANT', cachingSummary: expect.stringContaining('cache_control'), devOnly: false });
    expect(res.body.map((k: { kind: string }) => k.kind)).toContain('DEV_SCRIPTED');
  });

  it('accepts any well-formed kind at the input but only registered kinds', async () => {
    const unknown = await h.http().post('/v1/model-providers').set(auth(admin)).send({ kind: 'MISTRAL', name: 'Mistral' }).expect(400);
    expect(unknown.body.error).toMatchObject({ category: 'validation', code: 'provider_kind_not_available' });
    await h.http().post('/v1/model-providers').set(auth(admin)).send({ kind: 'not a kind', name: 'Bad' }).expect(400);
    const price = { providerKind: 'MISTRAL', modelPattern: 'mistral-large', inputPerMTokMicros: 1, outputPerMTokMicros: 1 };
    const priced = await h.http().post('/v1/model-pricing').set(auth(admin)).send(price).expect(400);
    expect(priced.body.error.code).toBe('provider_kind_not_available');
  });

  it('creates providers and never returns credential values', async () => {
    const created = await h
      .http()
      .post('/v1/model-providers')
      .set(auth(admin))
      .send({ kind: 'ANTHROPIC', name: 'Anthropic', region: 'global', residencyZone: 'GLOBAL', credentials: { apiKey: SECRET } })
      .expect(201);
    anthropicId = created.body.id;
    expect(created.text).not.toMatch(LEAKS);
    expect(Object.keys(created.body.secretRefs)).toEqual(['apiKey']);
    const scripted = await h
      .http()
      .post('/v1/model-providers')
      .set(auth(admin))
      .send({ kind: 'DEV_SCRIPTED', name: 'Scripted', region: 'ap-south-1', residencyZone: 'IN', settings: { latencyMs: 0, chunkDelayMs: 0 } })
      .expect(201);
    devId = scripted.body.id;

    const rotated = await h.http().patch(`/v1/model-providers/${anthropicId}`).set(auth(admin)).send({ credentials: { apiKey: ROTATED } }).expect(200);
    expect(rotated.text).not.toMatch(LEAKS);
    const list = await h.http().get('/v1/model-providers').set(auth(admin)).expect(200);
    expect(list.body).toHaveLength(2);
    expect(list.text).not.toMatch(LEAKS);
    const one = await h.http().get(`/v1/model-providers/${anthropicId}`).set(auth(admin)).expect(200);
    expect(one.text).not.toMatch(LEAKS);
  });

  it('keeps plaintext out of every table (ciphertext only in secrets)', async () => {
    for (const table of ['model_providers', 'secrets', 'audit_events', 'outbox_events']) {
      const rows = await h.db.db.execute(sql.raw(`SELECT row_to_json(t)::text AS j FROM ${table} t`));
      expect(JSON.stringify(rows.rows), table).not.toMatch(LEAKS);
    }
    const secrets = await h.db.db.execute(sql`SELECT ciphertext FROM secrets WHERE used_by = 'provider:Anthropic'`);
    expect(secrets.rows).toHaveLength(1);
    expect((secrets.rows[0] as { ciphertext: { data: string } }).ciphertext.data).toBeTruthy();
  });

  it('rejects invalid settings with a validation error', async () => {
    const res = await h
      .http()
      .post('/v1/model-providers')
      .set(auth(admin))
      .send({ kind: 'DEV_SCRIPTED', name: 'Broken', settings: { latencyMs: -5 } })
      .expect(400);
    expect(res.body.error).toMatchObject({ category: 'validation', code: 'provider_settings_invalid' });
  });

  it('tests a connection', async () => {
    const res = await h.http().post(`/v1/model-providers/${devId}/test`).set(auth(admin)).send({ model: 'scripted-1' }).expect(200);
    expect(res.body).toMatchObject({ status: 'OK', call: { ok: true } });
    const bare = await h.http().post(`/v1/model-providers/${devId}/test`).set(auth(admin)).expect(200);
    expect(bare.body.status).toBe('OK');
  });
});

describe('model profiles API', () => {
  it('creates a profile and dry-runs the policy check', async () => {
    const body = { name: 'support-primary', providerId: devId, model: 'scripted-1', fallbacks: [{ providerId: anthropicId, model: 'claude-haiku-4-5' }] };
    const check = await h.http().post('/v1/model-profiles/validate').set(auth(admin)).send(body).expect(200);
    expect(check.body).toMatchObject({ ok: true, primary: { permitted: true } });
    // Each target carries its provider's own caching description.
    expect(check.body.primary.caching).toMatchObject({ mode: 'explicit', mechanism: expect.stringContaining('simulated') });
    expect(check.body.fallbacks[0].caching).toMatchObject({ mode: 'explicit', mechanism: expect.stringContaining('cache_control'), effect: { '1h': 'breakpoints · 1h TTL' } });
    const created = await h.http().post('/v1/model-profiles').set(auth(admin)).send(body).expect(201);
    profileId = created.body.id;
    expect(created.body).toMatchObject({ name: 'support-primary', providerName: 'Scripted', configVersion: 1, policy: { ok: true } });
    expect(created.body.targets.map((t: { caching: { mode: string } | null }) => t.caching?.mode)).toEqual(['explicit', 'explicit']);
    // DEV_SCRIPTED is never priced; the Anthropic fallback gets the catalog price.
    expect(created.body.prices).toEqual([expect.objectContaining({ providerKind: 'ANTHROPIC', model: 'claude-haiku-4-5', status: 'added', origin: 'catalog' })]);
    const bad = await h.http().post('/v1/model-profiles').set(auth(admin)).send({ ...body, name: 'Support' }).expect(400);
    expect(bad.body.error.category).toBe('validation');
  });

  it('rejects a primary target that violates residency', async () => {
    await h.http().patch('/v1/settings/deployment').set(auth(admin)).send({ residencyZone: 'IN' }).expect(200);
    const res = await h
      .http()
      .post('/v1/model-profiles')
      .set(auth(admin))
      .send({ name: 'global-primary', providerId: anthropicId, model: 'claude-haiku-4-5' })
      .expect(403);
    expect(res.body.error).toMatchObject({ category: 'policy_denied', code: 'model_target_not_permitted', details: { reason: 'residency_violation' } });
    const updated = await h.http().patch(`/v1/model-profiles/${profileId}`).set(auth(admin)).send({ temperature: 0.3 }).expect(200);
    expect(updated.body.configVersion).toBe(2);
    expect(updated.body.policy.fallbacks[0]).toMatchObject({ permitted: false });
    expect(updated.body.policy.warnings).toHaveLength(1);
  });

  it('guards deletes of providers still in use', async () => {
    const res = await h.http().delete(`/v1/model-providers/${devId}`).set(auth(admin)).expect(409);
    expect(res.body.error.code).toBe('model_provider_in_use');
  });
});

describe('model administration RBAC', () => {
  it('lets a Lead read providers and profiles but change nothing', async () => {
    const profiles = await h.http().get('/v1/model-profiles').set(auth(lead)).expect(200);
    expect(profiles.body.map((p: { name: string }) => p.name)).toContain('support-primary');
    expect(profiles.body[0].stats24h).not.toBeNull();
    const providers = await h.http().get('/v1/model-providers').set(auth(lead)).expect(200);
    expect(providers.text).not.toMatch(LEAKS);
    await h.http().post('/v1/model-profiles').set(auth(lead)).send({ name: 'lead-profile', providerId: devId, model: 'scripted-1' }).expect(403);
    await h.http().post('/v1/model-profiles/validate').set(auth(lead)).send({ name: 'lead-profile', providerId: devId, model: 'scripted-1' }).expect(403);
    await h.http().patch(`/v1/model-profiles/${profileId}`).set(auth(lead)).send({ temperature: 1 }).expect(403);
    await h.http().delete(`/v1/model-profiles/${profileId}`).set(auth(lead)).expect(403);
    await h.http().post('/v1/model-providers').set(auth(lead)).send({ kind: 'DEV_SCRIPTED', name: 'Lead dev' }).expect(403);
    await h.http().post(`/v1/model-providers/${devId}/test`).set(auth(lead)).expect(403);
    await h.http().get('/v1/model-pricing').set(auth(lead)).expect(403);
  });

  it('denies Service members provider access; profile listing carries no technical telemetry', async () => {
    await h.http().get('/v1/model-providers').set(auth(exec)).expect(403);
    await h.http().get('/v1/model-providers/kinds').set(auth(exec)).expect(403);
    await h.http().post('/v1/model-providers').set(auth(exec)).send({ kind: 'DEV_SCRIPTED', name: 'Exec dev' }).expect(403);
    await h.http().patch(`/v1/model-providers/${devId}`).set(auth(exec)).send({ enabled: false }).expect(403);
    await h.http().delete(`/v1/model-providers/${devId}`).set(auth(exec)).expect(403);
    await h.http().post('/v1/model-profiles').set(auth(exec)).send({ name: 'exec-profile', providerId: devId, model: 'scripted-1' }).expect(403);
    await h.http().post('/v1/model-pricing').set(auth(exec)).send({}).expect(403);
    // Execs hold agents.read, so they may see which profiles exist, without usage figures.
    const profiles = await h.http().get('/v1/model-profiles').set(auth(exec)).expect(200);
    expect(profiles.body.every((p: { stats24h: unknown }) => p.stats24h === null)).toBe(true);
  });

  it('gives the Tech admin full pricing control', async () => {
    const created = await h
      .http()
      .post('/v1/model-pricing')
      .set(auth(admin))
      .send({ providerKind: 'ANTHROPIC', modelPattern: 'claude-haiku-4-*', inputPerMTokMicros: 1_000_000, outputPerMTokMicros: 5_000_000 })
      .expect(201);
    await h.http().patch(`/v1/model-pricing/${created.body.id}`).set(auth(admin)).send({ outputPerMTokMicros: 4_000_000 }).expect(200);
    const list = await h.http().get('/v1/model-pricing').set(auth(admin)).expect(200);
    // The profile's Anthropic fallback was priced from the model catalog when the profile was saved (ADR-027).
    expect(list.body).toEqual([
      expect.objectContaining({ modelPattern: 'claude-haiku-4-*', outputPerMTokMicros: 4_000_000, currency: 'USD', origin: 'manual' }),
      expect.objectContaining({ modelPattern: 'claude-haiku-4-5', currency: 'USD', origin: 'catalog', catalogSource: 'models.dev' }),
    ]);
    await h.http().delete(`/v1/model-pricing/${created.body.id}`).set(auth(admin)).expect(204);
  });

  it('lets the Tech admin delete an unused profile and provider', async () => {
    await h.http().delete(`/v1/model-profiles/${profileId}`).set(auth(admin)).expect(204);
    await h.http().delete(`/v1/model-providers/${anthropicId}`).set(auth(admin)).expect(204);
    const left = await h.db.db.execute(sql`SELECT count(*)::int AS n FROM secrets`);
    expect((left.rows[0] as { n: number }).n).toBe(0);
  });
});
