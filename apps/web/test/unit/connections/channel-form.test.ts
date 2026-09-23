import { describe, expect, it } from 'vitest';
import { TWILIO_WHATSAPP_DESCRIPTOR } from '../../../../../packages/channels/src/twilio-whatsapp/descriptor';
import { WEBCHAT_DESCRIPTOR } from '../../../../../packages/channels/src/webchat/descriptor';
import { WHATSAPP_DESCRIPTOR } from '../../../../../packages/channels/src/whatsapp/descriptor';
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
    expect(webchat.groups.map((g) => g.path)).toEqual(['branding']);
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
    });
  });

  it('round-trips stored settings for editing', () => {
    const stored = { allowedOrigins: ['https://a.example.com'], audioAttachments: true, branding: { title: 'Help', position: 'left' } };
    const values = initialSettingsValues(webchat, stored);
    expect(values['allowedOrigins']).toBe('https://a.example.com');
    expect(values['branding.position']).toBe('left');
    expect(buildSettings(webchat, values).settings).toEqual({ ...stored, branding: { title: 'Help', position: 'left' } });
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
