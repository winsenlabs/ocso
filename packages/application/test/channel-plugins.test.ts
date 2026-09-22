import { afterEach, describe, expect, it } from 'vitest';
import { createChannelEgress, maskIdentity, setIdentityDisplay } from '../src/index.js';

describe('identity masking', () => {
  afterEach(() => setIdentityDisplay(null));

  it('masks by identity shape, never by channel kind', () => {
    expect(maskIdentity('whatsapp_phone:+919812341208')).toBe('+91 98•••41208');
    expect(maskIdentity('any_kind:+14155238886')).toBe('+1 41•••38886');
    expect(maskIdentity('email:priya.deshmukh@example.com')).toBe('priya@…');
    expect(maskIdentity('webchat_visitor:v_0123456789abcdef8f2a')).toBe('v_01…8f2a');
    expect(maskIdentity('short:abc')).toBe('abc');
    expect(maskIdentity(null)).toBeNull();
  });

  it('lets the channel plugin that owns an identity kind display it (installed from the registry)', () => {
    setIdentityDisplay((kind, value) => (kind === 'webchat_visitor' ? `web · sess ${value.slice(-4)}` : null));
    expect(maskIdentity('webchat_visitor:v_0123456789abcdef8f2a')).toBe('web · sess 8f2a');
    expect(maskIdentity('whatsapp_phone:+919812341208')).toBe('+91 98•••41208');
  });
});

describe('channel egress', () => {
  it('refuses private addresses and plain http without an allowlist (SSRF guard)', async () => {
    const egress = createChannelEgress();
    try {
      await expect(egress.fetch('http://127.0.0.1:9/2010-04-01/Accounts.json')).rejects.toMatchObject({ name: 'EgressBlockedError' });
      await expect(egress.fetch('https://127.0.0.1:9/')).rejects.toMatchObject({ name: 'EgressBlockedError' });
      await expect(egress.fetch('https://169.254.169.254/latest/meta-data')).rejects.toMatchObject({ name: 'EgressBlockedError' });
    } finally {
      egress.close();
    }
  });
});
