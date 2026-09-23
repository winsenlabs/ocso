import { describe, expect, it } from 'vitest';
import { TWILIO_WHATSAPP_DESCRIPTOR } from '../../../../../packages/channels/src/twilio-whatsapp/descriptor';
import { WEBCHAT_DESCRIPTOR } from '../../../../../packages/channels/src/webchat/descriptor';
import { WHATSAPP_DESCRIPTOR } from '../../../../../packages/channels/src/whatsapp/descriptor';
import { embedTabsFor, nativeSnippet, reactSnippet, scriptHint, scriptSnippet, serverSnippet } from '../../../components/connections/channels/embed-snippets';
import {
  buildSettings,
  embedSnippet,
  identitySettingOf,
  inboundWebhookUrl,
  initialSettingsValues,
  randomSecret,
  settingsGroups,
  splitProblems,
} from '../../../components/connections/channels/settings-form';

describe('channel settings form from the adapters’ JSON Schema', () => {
  const webchat = settingsGroups(WEBCHAT_DESCRIPTOR.settingsSchema);
  const whatsapp = settingsGroups(WHATSAPP_DESCRIPTOR.settingsSchema);

  it('turns nested objects into groups and string arrays into lists', () => {
    expect(webchat.groups.map((g) => g.path)).toEqual(['branding', 'auth', 'context']);
    expect(webchat.groups[0]!.fields.map((f) => f.path)).toContain('branding.accentColor');
    const origins = webchat.fields.find((f) => f.path === 'allowedOrigins');
    expect(origins?.kind).toBe('list');
    expect(webchat.fields.find((f) => f.path === 'audioAttachments')?.kind).toBe('boolean');
    expect(webchat.groups[0]!.fields.find((f) => f.path === 'branding.theme')).toMatchObject({ kind: 'enum', defaultValue: 'light' });
    expect(whatsapp.fields.find((f) => f.path === 'phoneNumberId')).toMatchObject({ required: true, kind: 'text' });
  });

  it('builds nested settings, one origin per line, and leaves blank fields to the adapter default', () => {
    const values = {
      ...initialSettingsValues(webchat, null),
      allowedOrigins: 'https://shop.example.com\n  https://*.example.com \n',
      'branding.title': 'Meridian help',
      'branding.theme': 'dark',
      maxAttachmentsPerMessage: '3',
    };
    const { settings, errors } = buildSettings(webchat, values);
    expect(errors).toEqual({});
    expect(settings).toEqual({
      allowedOrigins: ['https://shop.example.com', 'https://*.example.com'],
      maxAttachmentsPerMessage: 3,
      audioAttachments: false,
      branding: { title: 'Meridian help', theme: 'dark' },
      auth: { allowNativeApps: false },
    });
  });

  it('round-trips stored settings for editing', () => {
    const stored = { allowedOrigins: ['https://a.example.com'], audioAttachments: true, branding: { title: 'Help', position: 'left' } };
    const values = initialSettingsValues(webchat, stored);
    expect(values['allowedOrigins']).toBe('https://a.example.com');
    expect(values['branding.position']).toBe('left');
    expect(buildSettings(webchat, values).settings).toEqual({ ...stored, branding: { title: 'Help', position: 'left' }, auth: { allowNativeApps: false } });
  });

  it('offers a choice between shapes (oneOf with a const discriminator) and builds only the chosen one', () => {
    const auth = webchat.groups.find((g) => g.path === 'auth')!;
    expect(auth.fields.find((f) => f.path === 'auth.mode')).toMatchObject({ kind: 'enum', options: ['anonymous', 'client', 'user'], defaultValue: 'anonymous' });
    const userToken = auth.groups.find((g) => g.path === 'auth.userToken')!;
    expect(userToken.variant).toMatchObject({ discriminator: 'verify', required: false });
    expect(userToken.variant!.options.map((o) => o.value)).toEqual(['jwks', 'hs256']);
    const jwks = userToken.variant!.options[0]!.group;
    expect(jwks.fields.map((f) => f.path)).toEqual(['auth.userToken.jwksUrl', 'auth.userToken.issuer', 'auth.userToken.audience', 'auth.userToken.algorithms']);
    expect(jwks.fields.find((f) => f.path === 'auth.userToken.algorithms')?.kind).toBe('list');

    const values = {
      ...initialSettingsValues(webchat, null),
      'auth.mode': 'user',
      'auth.userToken.verify': 'jwks',
      'auth.userToken.jwksUrl': 'https://id.example.com/.well-known/jwks.json',
      'auth.userToken.issuer': 'https://id.example.com',
      'auth.userToken.audience': 'ocso',
      'auth.userToken.algorithms': 'RS256\nES256',
      'context.allow': 'plan\norderId',
      toolIdentity: 'passthrough',
    };
    expect(buildSettings(webchat, values).settings).toMatchObject({
      auth: {
        mode: 'user',
        allowNativeApps: false,
        userToken: { verify: 'jwks', jwksUrl: 'https://id.example.com/.well-known/jwks.json', issuer: 'https://id.example.com', audience: 'ocso', algorithms: ['RS256', 'ES256'] },
      },
      context: { allow: ['plan', 'orderId'] },
      toolIdentity: 'passthrough',
    });
    // Required fields of the chosen shape are checked; switching to HS256 drops the JWKS-only fields.
    expect(buildSettings(webchat, { ...values, 'auth.userToken.jwksUrl': '' }).errors).toEqual({ 'auth.userToken.jwksUrl': 'Required' });
    expect(buildSettings(webchat, { ...values, 'auth.userToken.verify': 'hs256' }).settings['auth']).toEqual({
      mode: 'user',
      allowNativeApps: false,
      userToken: { verify: 'hs256', issuer: 'https://id.example.com', audience: 'ocso' },
    });
    expect(buildSettings(webchat, { ...values, 'auth.userToken.verify': '' }).settings['auth']).toEqual({ mode: 'user', allowNativeApps: false });
    // Stored shapes round-trip.
    const stored = buildSettings(webchat, values).settings;
    expect(buildSettings(webchat, initialSettingsValues(webchat, stored)).settings).toEqual(stored);
  });

  it('renders the Twilio form from its descriptor: titled fields, optional sender, status callbacks on by default', () => {
    const twilio = settingsGroups(TWILIO_WHATSAPP_DESCRIPTOR.settingsSchema);
    expect(twilio.fields.find((f) => f.path === 'accountSid')).toMatchObject({ label: 'Account SID', required: true, kind: 'text' });
    expect(twilio.fields.find((f) => f.path === 'from')).toMatchObject({ label: 'WhatsApp sender', required: false });
    expect(twilio.fields.find((f) => f.path === 'statusCallback')).toMatchObject({ kind: 'boolean', defaultValue: true });
    const values = { ...initialSettingsValues(twilio, null), accountSid: 'ACa1b2c3d4e5f60718293a4b5c6d7e8f90', from: 'whatsapp:+14155238886' };
    expect(buildSettings(twilio, values)).toEqual({ settings: { accountSid: 'ACa1b2c3d4e5f60718293a4b5c6d7e8f90', from: 'whatsapp:+14155238886', statusCallback: true }, errors: {} });
  });

  it('reports client-side problems by path', () => {
    const values = { ...initialSettingsValues(whatsapp, null), phoneNumberId: '', mediaLinkTtlSeconds: '10' };
    expect(buildSettings(whatsapp, values).errors).toEqual({ phoneNumberId: 'Required', mediaLinkTtlSeconds: 'At least 60' });
  });
});

describe('channel API problems, secrets and next steps', () => {
  it('splits the API message into settings, secrets and field messages', () => {
    const p = splitProblems('settings.phoneNumberId: must be a numeric Meta id; secrets.verifyToken: must be at least 16 characters; name: Too small; something odd');
    expect(p).toEqual({
      settings: { phoneNumberId: 'must be a numeric Meta id' },
      secrets: { verifyToken: 'must be at least 16 characters' },
      fields: { name: 'Too small' },
      other: ['something odd'],
    });
    expect(splitProblems('settings.branding.accentColor: must be a #rrggbb colour').settings).toEqual({ 'branding.accentColor': 'must be a #rrggbb colour' });
  });

  it('generates whitespace-free secrets long enough for every adapter check', () => {
    const a = randomSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomSecret()).not.toBe(a);
  });

  it('builds the webhook URL from the path the API derived from the descriptor (never from the kind), and the embed snippet', () => {
    expect(inboundWebhookUrl('https://ocso.example.com/', { webhookPath: '/channels/whatsapp/k1/webhook' })).toBe('https://ocso.example.com/channels/whatsapp/k1/webhook');
    expect(inboundWebhookUrl('https://ocso.example.com', { webhookPath: null })).toBeNull();
    expect(inboundWebhookUrl('https://ocso.example.com', { webhookPath: '/channels/twilio-whatsapp/k3/webhook' })).toBe('https://ocso.example.com/channels/twilio-whatsapp/k3/webhook');
    expect(embedSnippet('https://ocso.example.com', 'abc')).toBe('<script src="https://ocso.example.com/ocso-webchat.js" data-key="abc" async></script>');
  });

  it('shows the identifying setting the descriptor names (first key with a value)', () => {
    const setting = TWILIO_WHATSAPP_DESCRIPTOR.identitySetting ?? null;
    expect(identitySettingOf({ messagingServiceSid: 'MG123' }, setting)).toEqual({ k: 'sender', v: 'MG123' });
    expect(identitySettingOf({ from: 'whatsapp:+14155238886', messagingServiceSid: 'MG123' }, setting)).toEqual({ k: 'sender', v: 'whatsapp:+14155238886' });
    expect(identitySettingOf({}, setting)).toBeNull();
    expect(identitySettingOf({ from: 'x' }, null)).toBeNull();
  });
});

describe('embed snippets for the SDKs and the backend', () => {
  const t = { origin: 'https://ocso.example.com/', publishableKey: 'pk_abc123', authMode: 'anonymous' };

  it('keeps the script tag identical to the classic embed snippet', () => {
    expect(scriptSnippet(t)).toBe(embedSnippet('https://ocso.example.com', 'pk_abc123'));
  });

  it('points the React and React Native SDKs at the API with the publishable key, fetching a pass unless anonymous', () => {
    expect(reactSnippet(t)).toContain("baseUrl: 'https://ocso.example.com'");
    expect(reactSnippet(t)).toContain("publishableKey: 'pk_abc123'");
    expect(reactSnippet(t)).not.toContain('getSessionPass');
    expect(reactSnippet({ ...t, authMode: 'client' })).toContain('getSessionPass');
    expect(nativeSnippet(t)).toContain("from '@winsendotai/ocso-chat-react/native'");
    expect(nativeSnippet(t)).toContain('Allow native apps');
    expect(nativeSnippet({ ...t, authMode: 'user' })).toContain('getSessionPass');
  });

  it('mints session passes server-side with the secret key from the environment (never inlined)', () => {
    const server = serverSnippet(t);
    expect(server).toContain('https://ocso.example.com/public/webchat/pk_abc123/session-pass');
    expect(server).toContain('process.env.OCSO_SECRET_KEY');
    expect(server).not.toMatch(/sk_[A-Za-z0-9_-]{20,}/);
  });

  it('leaves out the script tag in client mode (the hosted widget cannot fetch passes) and warns about identify in user mode', () => {
    expect(embedTabsFor('anonymous').map((x) => x.id)).toEqual(['script', 'react', 'native', 'server']);
    expect(embedTabsFor('user').map((x) => x.id)).toEqual(['script', 'react', 'native', 'server']);
    expect(embedTabsFor('client').map((x) => x.id)).toEqual(['react', 'native', 'server']);
    expect(scriptHint('user')).toContain('OcsoWebChat.identify(userToken)');
    expect(scriptHint('anonymous')).not.toContain('identify');
  });
});
