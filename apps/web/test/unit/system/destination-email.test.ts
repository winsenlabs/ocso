import { describe, expect, it } from 'vitest';
import { buildConfig, configSummary, configText, fieldVisible, secretVisible, specOf } from '../../../components/alerts/destination-form';

const email = specOf('EMAIL');
const visible = (text: Record<string, string>) => email.fields.filter((f) => fieldVisible(f, text)).map((f) => f.name);

describe('email destination: deployment sender or own SMTP relay', () => {
  it('defaults new destinations to the deployment sender with recipients only and no password', () => {
    const text = configText('EMAIL', null);
    expect(text.transport).toBe('deployment');
    expect(visible(text)).toEqual(['transport', 'to']);
    expect(secretVisible(email, text)).toBe(false);
    expect(buildConfig('EMAIL', { ...text, to: 'a@x.io, b@x.io', host: 'stale.example.com' })).toEqual({ transport: 'deployment', to: ['a@x.io', 'b@x.io'] });
    expect(configSummary('EMAIL', { transport: 'deployment', to: ['a@x.io'] })).toBe('a@x.io via deployment email');
  });

  it('shows and sends SMTP settings for the smtp transport', () => {
    const text = { ...configText('EMAIL', null), transport: 'smtp', host: 'smtp.example.com', port: '465', from: 'ocso@example.com', to: 'a@x.io' };
    expect(visible(text)).toEqual(['transport', 'to', 'host', 'port', 'from', 'username', 'requireTLS']);
    expect(secretVisible(email, text)).toBe(true);
    expect(buildConfig('EMAIL', text)).toEqual({ transport: 'smtp', to: ['a@x.io'], host: 'smtp.example.com', port: 465, from: 'ocso@example.com', requireTLS: true });
  });

  it('opens legacy SMTP configs (saved before `transport`) as SMTP', () => {
    const legacy = { host: 'smtp.example.com', port: 587, from: 'ocso@example.com', to: ['a@x.io'], requireTLS: true };
    expect(configText('EMAIL', legacy)).toMatchObject({ transport: 'smtp', host: 'smtp.example.com', to: 'a@x.io' });
    expect(configSummary('EMAIL', legacy)).toBe('a@x.io via smtp.example.com');
  });
});
