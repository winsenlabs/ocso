import { describe, expect, it } from 'vitest';
import {
  ChannelRegistry,
  createMsTeamsAdapter,
  createSlackChannelAdapter,
  createTwilioWhatsAppAdapter,
  createWebChatAdapter,
  createWhatsAppAdapter,
  fillSetupTemplate,
  setupFileProblems,
  setupGuideOf,
  setupGuideProblems,
  type ChannelAdapter,
  type ChannelKindDescriptor,
  type ChannelSetupFile,
} from '../src/index.js';

const manifest: ChannelSetupFile = { key: 'manifest', label: 'Manifest', filename: 'm.json', contentType: 'application/json', template: '{"u":"{{webhookUrl}}"}' };
const guide = (over: Partial<ChannelKindDescriptor>) => setupGuideProblems({ setupFiles: [manifest], ...over });

describe('descriptor setup guide (setupGuide, troubleshooting)', () => {
  it('accepts a complete guide', () => {
    expect(
      guide({
        setupGuide: [
          {
            title: 'Create the app',
            body: 'Paste the manifest.',
            items: ['one'],
            table: { head: ['Scope', 'Why'], rows: [['chat:write', 'reply']] },
            values: [{ label: 'Request URL', value: '{{webhookUrl}}' }],
            links: [{ label: 'Console', href: 'https://example.com/apps' }],
            files: ['manifest'],
            check: 'It shows Verified.',
          },
          { title: 'Paste the keys', body: '', form: true },
        ],
        troubleshooting: [{ id: 'url-not-verified', problem: 'Not verified', fix: 'Retry after saving.' }],
      }),
    ).toEqual([]);
  });

  it.each([
    ['a javascript: link', { setupGuide: [{ title: 'T', body: '', links: [{ label: 'x', href: 'javascript:alert(1)' }] }] }, 'https href'],
    ['an http link', { setupGuide: [{ title: 'T', body: '', links: [{ label: 'x', href: 'http://example.com' }] }] }, 'https href'],
    ['a secret placeholder in a value', { setupGuide: [{ title: 'T', body: '', values: [{ label: 'x', value: '{{secrets.botToken}}' }] }] }, 'unknown placeholder'],
    ['an unknown setup file', { setupGuide: [{ title: 'T', body: '', files: ['nope'] }] }, 'unknown setup file'],
    ['two form steps', { setupGuide: [{ title: 'A', body: '', form: true }, { title: 'B', body: '', form: true }] }, 'at most one step'],
    ['an empty title', { setupGuide: [{ title: ' ', body: '' }] }, 'title is required'],
    ['a three-column table', { setupGuide: [{ title: 'T', body: '', table: { head: ['a', 'b', 'c'], rows: [['1', '2', '3']] } as never }] }, 'two-column'],
    ['duplicate troubleshooting ids', { troubleshooting: [{ id: 'a', problem: 'p', fix: 'f' }, { id: 'a', problem: 'p', fix: 'f' }] }, 'duplicate id'],
    ['a bad troubleshooting id', { troubleshooting: [{ id: 'Not An Id', problem: 'p', fix: 'f' }] }, 'invalid id'],
    ['a troubleshooting entry without a fix', { troubleshooting: [{ id: 'a', problem: 'p', fix: '' }] }, 'fix is required'],
  ] as Array<[string, Partial<ChannelKindDescriptor>, string]>)('refuses %s', (_name, over, message) => {
    expect(guide(over).join('\n')).toContain(message);
  });

  it('turns deprecated setupSteps into a guide, one step per sentence', () => {
    expect(setupGuideOf({ setupSteps: ['Do this.', 'Then that.'] })).toEqual([
      { title: 'Do this.', body: '' },
      { title: 'Then that.', body: '' },
    ]);
    expect(setupGuideOf({})).toEqual([]);
  });

  it('every built-in kind has a valid guide, and every webhook kind has a form step and troubleshooting', () => {
    const registry = new ChannelRegistry();
    for (const adapter of [createWhatsAppAdapter(), createTwilioWhatsAppAdapter(), createWebChatAdapter(), createSlackChannelAdapter(), createMsTeamsAdapter()]) registry.register(adapter);
    for (const info of registry.describeAll()) {
      expect(setupGuideProblems(info), info.kind).toEqual([]);
      expect(info.setupGuide.length, info.kind).toBeGreaterThan(0);
      expect(info.setupGuide.filter((s) => s.form), info.kind).toHaveLength(1);
      if (info.inboundWebhook) expect(info.troubleshooting.length, info.kind).toBeGreaterThan(0);
    }
  });

  it('registration refuses a kind with a broken guide', () => {
    const base = createWebChatAdapter();
    const broken = Object.assign(Object.create(Object.getPrototypeOf(base) as object) as ChannelAdapter, base, {
      describe: () => ({ ...base.describe(), setupGuide: [{ title: 'T', body: '', links: [{ label: 'x', href: 'javascript:void(0)' }] }] }),
    });
    expect(() => new ChannelRegistry().register(broken)).toThrow(/https href/);
  });
});

describe('setup file packages (application/zip)', () => {
  const png = 'iVBORw0KGgo=';
  const pkg = (entries: ChannelSetupFile['entries'], over: Partial<ChannelSetupFile> = {}): ChannelSetupFile => ({ key: 'pkg', label: 'Package', filename: 'app.zip', contentType: 'application/zip', entries, ...over });

  it('accepts text templates and base64 images', () => {
    expect(setupFileProblems([pkg([{ path: 'manifest.json', contentType: 'application/json', template: '{"id":"{{settings.appId}}","d":["{{webhookHost}}"]}' }, { path: 'color.png', contentType: 'image/png', base64: png }])])).toEqual([]);
  });

  it.each([
    ['no entries', pkg([]), 'entries must list'],
    ['a template on the zip itself', pkg([{ path: 'a.json', contentType: 'application/json', template: '{}' }], { template: '{}' }), 'not a template'],
    ['a path outside the root', pkg([{ path: '../evil.json', contentType: 'application/json', template: '{}' }]), 'invalid path'],
    ['duplicate paths', pkg([0, 1].map(() => ({ path: 'a.json', contentType: 'application/json' as const, template: '{}' }))), 'duplicate path'],
    ['an image without base64', pkg([{ path: 'c.png', contentType: 'image/png', template: 'x' }]), 'base64 bytes only'],
    ['a secret placeholder in an entry', pkg([{ path: 'm.json', contentType: 'application/json', template: '{"s":"{{secrets.appPassword}}"}' }]), 'unknown placeholder'],
    ['an html entry', pkg([{ path: 'i.html', contentType: 'text/html' as never, template: '<p>' }]), 'contentType must be'],
  ] as Array<[string, ChannelSetupFile, string]>)('refuses %s', (_name, file, message) => {
    expect(setupFileProblems([file]).join('\n')).toContain(message);
  });

  it('fills {{webhookHost}} from the webhook URL', () => {
    expect(fillSetupTemplate('["{{webhookHost}}"]', 'application/json', { webhookUrl: 'https://ocso.example.com:8443/channels/x/k/webhook', settings: {} })).toEqual({ content: '["ocso.example.com:8443"]', missing: [] });
    expect(fillSetupTemplate('["{{webhookHost}}"]', 'application/json', { webhookUrl: null, settings: {} }).missing).toEqual(['webhookHost']);
  });
});
