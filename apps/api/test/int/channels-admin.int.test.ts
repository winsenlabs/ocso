import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { maskIdentity } from '@ocso/application';
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
    // Everything the web app renders per kind comes from the descriptor.
    expect(whatsapp).toMatchObject({ mark: { code: 'WA', name: 'WhatsApp' }, identitySetting: { label: 'number id' }, webhookEvents: expect.any(String), messageTemplates: true, templates: { reviewer: 'WhatsApp' } });
    expect(whatsapp.setupSteps.length).toBeGreaterThan(2);
    expect(webchat).toMatchObject({ mark: { code: 'WB', name: 'Web chat' }, messageTemplates: false, connectionCheck: false });
  });

  it('lets every area that shows channels read the kinds, and nobody else', async () => {
    const mk = async (email: string, role: string) => {
      await h.http().post('/v1/users').set(auth(admin)).send({ email, name: email.split('@')[0], role, password: 'a password 12345' }).expect(201);
      return h.loginAs(email, 'a password 12345');
    };
    const exec = await mk('kinds-exec@ocso.test', 'SERVICE');
    const lead = await mk('kinds-lead@ocso.test', 'HEAD');
    const kinds = await h.http().get('/v1/channels/kinds').set(auth(exec)).expect(200);
    expect(kinds.body.map((k: { kind: string }) => k.kind)).toEqual(['TWILIO_WHATSAPP', 'WHATSAPP', 'WEBCHAT']);
    await h.http().get('/v1/channels/kinds').set(auth(lead)).expect(200);
    await h.http().get('/v1/channels/kinds').expect(401);
  });

  it('installs the channel plugins’ identity display for list views at start-up', () => {
    // Web chat owns `webchat_visitor`; everything else keeps the generic, shape-based masking.
    expect(maskIdentity('webchat_visitor:v_0123456789abcdef8f2a')).toBe('web · sess 8f2a');
    expect(maskIdentity('whatsapp_phone:+919812341208')).toBe('+91 98•••41208');
  });

  it('reports the widget page (not a webhook) for embeddable channels', async () => {
    const created = await h.http().post('/v1/channels').set(auth(admin)).send({ kind: 'WEBCHAT', name: 'Help chat', status: 'ACTIVE', settings: {} }).expect(201);
    expect(created.body).toMatchObject({ webhookPath: null, embedPath: `/chat/${created.body.publicKey}` });
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
