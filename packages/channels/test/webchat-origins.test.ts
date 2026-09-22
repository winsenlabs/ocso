import { describe, expect, it } from 'vitest';
import { createWebChatAdapter, originAllowed, validateWebChatConfig, WebChatSettings } from '../src/index.js';

const secrets = { visitorTokenSecret: 'v'.repeat(40) };

describe('web chat embedding allowlist', () => {
  it('matches exact origins and single-level wildcards only', () => {
    const list = ['https://shop.example.com', 'http://localhost:5440', 'https://*.brand.test'];
    expect(originAllowed('https://shop.example.com', list)).toBe(true);
    expect(originAllowed('http://localhost:5440', list)).toBe(true);
    expect(originAllowed('https://help.brand.test', list)).toBe(true);
    expect(originAllowed('https://a.b.brand.test', list)).toBe(true);
    expect(originAllowed('https://brand.test', list)).toBe(false);
    expect(originAllowed('http://help.brand.test', list)).toBe(false);
    expect(originAllowed('https://shop.example.com.evil.test', list)).toBe(false);
    expect(originAllowed('https://evilbrand.test', list)).toBe(false);
    expect(originAllowed('http://localhost:5441', list)).toBe(false);
    expect(originAllowed('null', list)).toBe(false);
    expect(originAllowed('not a url', list)).toBe(false);
  });

  it('validates allowlist entries and branding as channel settings', () => {
    expect(validateWebChatConfig({ allowedOrigins: ['https://shop.example.com'], branding: { accentColor: '#0F766E', position: 'left' } }, secrets)).toEqual([]);
    expect(validateWebChatConfig({ allowedOrigins: ['https://shop.example.com/path'] }, secrets)[0]).toMatch(/allowedOrigins\.0/);
    expect(validateWebChatConfig({ allowedOrigins: ['*'] }, secrets)).not.toEqual([]);
    expect(validateWebChatConfig({ branding: { accentColor: 'red' } }, secrets)[0]).toMatch(/branding\.accentColor/);
    const parsed = WebChatSettings.parse({ allowedOrigins: ['HTTPS://Shop.Example.com'] });
    expect(parsed.allowedOrigins).toEqual(['https://shop.example.com']);
    expect(parsed.branding).toEqual({ theme: 'light', position: 'right' });
  });

  it('accepts audio attachments only when the channel opts in', () => {
    const adapter = createWebChatAdapter();
    const base = { id: 'ch_1', kind: 'WEBCHAT' as const, name: 'Web chat', secrets };
    const off = adapter.capabilities({ ...base, settings: {} });
    const on = adapter.capabilities({ ...base, settings: { audioAttachments: true } });
    expect(off.inboundParts).not.toContain('AUDIO');
    expect(off.maxMediaBytes.AUDIO).toBe(0);
    expect(on.inboundParts).toContain('AUDIO');
    expect(on.allowedMimeTypes.AUDIO).toEqual(['audio/mpeg', 'audio/mp4', 'audio/ogg']);
    expect(on.maxMediaBytes.AUDIO).toBeGreaterThan(0);
    expect(on.outboundParts).toEqual(off.outboundParts);
  });
});
