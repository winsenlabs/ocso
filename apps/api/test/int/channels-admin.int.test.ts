import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completeSetup, startApi, type ApiHarness } from './harness.js';

let h: ApiHarness;
let admin: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  h = await startApi();
  admin = await completeSetup(h);
});
afterAll(async () => {
  await h?.close();
});

describe('channel administration (design/04 Channels)', () => {
  it('describes each channel kind for the add-channel form, without any secret values', async () => {
    const res = await h.http().get('/v1/channels/kinds').set(auth(admin)).expect(200);
    const whatsapp = res.body.find((k: { kind: string }) => k.kind === 'WHATSAPP');
    const webchat = res.body.find((k: { kind: string }) => k.kind === 'WEBCHAT');
    expect(whatsapp).toMatchObject({ label: expect.any(String), inboundWebhook: true, embeddable: false });
    expect(Object.keys(whatsapp.settingsSchema.properties)).toContain('phoneNumberId');
    expect(whatsapp.secrets.map((s: { key: string }) => s.key)).toEqual(['accessToken', 'appSecret', 'verifyToken']);
    expect(webchat).toMatchObject({ embeddable: true });
    expect(Object.keys(webchat.settingsSchema.properties)).toEqual(expect.arrayContaining(['allowedOrigins', 'branding']));
  });

  it('generates server-side secrets the admin never needs to see', async () => {
    const created = await h.http().post('/v1/channels').set(auth(admin)).send({ kind: 'WEBCHAT', name: 'Website chat', status: 'ACTIVE', settings: { allowedOrigins: ['https://www.meridian.example'] } }).expect(201);
    expect(Object.keys(created.body.secretRefs)).toContain('visitorTokenSecret');
    expect(JSON.stringify(created.body)).not.toMatch(/"visitorTokenSecret":"[A-Za-z0-9_-]{40,}"/);
    const session = await h.http().post(`/public/webchat/${created.body.publicKey}/session`).send({}).expect(200);
    expect(session.body.token).toEqual(expect.any(String));
  });

  it('a partial update changes only the fields it sends', async () => {
    const settings = { allowedOrigins: ['https://shop.meridian.example'] };
    const created = await h.http().post('/v1/channels').set(auth(admin)).send({ kind: 'WEBCHAT', name: 'Shop chat', status: 'ACTIVE', settings }).expect(201);
    const renamed = await h.http().patch(`/v1/channels/${created.body.id}`).set(auth(admin)).send({ name: 'Shop chat (EU)' }).expect(200);
    expect(renamed.body).toMatchObject({ name: 'Shop chat (EU)', status: 'ACTIVE', settings: expect.objectContaining(settings) });
    expect(Object.keys(renamed.body.secretRefs)).toEqual(Object.keys(created.body.secretRefs));
  });
});
