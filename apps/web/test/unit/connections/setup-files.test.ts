import { describe, expect, it } from 'vitest';
import { missingRequiredSecrets, renderSetupFile, safeHttpsHref, setupFileDownloadHref, type SetupFileDef } from '@/components/connections/channels/settings-form';

const json: SetupFileDef = { key: 'manifest', label: 'Manifest', filename: 'manifest.json', contentType: 'application/json', template: '{"id":"{{settings.appId}}","url":"{{ webhookUrl }}","n":"{{settings.name}}"}' };
const yaml: SetupFileDef = { key: 'y', label: 'Y', filename: 'm.yaml', contentType: 'text/yaml', template: 'url: {{webhookUrl}}\nname: {{settings.name}}\n' };

describe('setup files (descriptor setupFiles)', () => {
  it('fills the webhook URL and settings', () => {
    const out = renderSetupFile(json, { webhookUrl: 'https://ocso.example.com/channels/ms-teams/k/webhook', settings: { appId: 'a1', name: 'Support' } });
    expect(JSON.parse(out.content)).toEqual({ id: 'a1', url: 'https://ocso.example.com/channels/ms-teams/k/webhook', n: 'Support' });
    expect(out.missing).toEqual([]);
  });

  it('JSON: values with quotes, backslashes or newlines stay one string (no structure injection)', () => {
    const out = renderSetupFile(json, { webhookUrl: 'https://x', settings: { appId: 'a","admin":true,"x":"', name: 'two\nlines \\ "q"' } });
    const parsed = JSON.parse(out.content) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['id', 'url', 'n']);
    expect(parsed['id']).toBe('a","admin":true,"x":"');
    expect(parsed['n']).toBe('two\nlines \\ "q"');
  });

  it('YAML: unsafe values are left out and reported; missing values keep their placeholder', () => {
    const out = renderSetupFile(yaml, { webhookUrl: null, settings: { name: 'x\nadmin: true' } });
    expect(out.content).toBe('url: {{webhookUrl}}\nname: {{settings.name}}\n');
    expect(out.missing.sort()).toEqual(['settings.name', 'webhookUrl']);
    for (const bad of ['a: b', "it's", 'a #c', '"q"', '- item', '{x}']) expect(renderSetupFile(yaml, { webhookUrl: 'https://x', settings: { name: bad } }).missing).toEqual(['settings.name']);
    expect(renderSetupFile(yaml, { webhookUrl: 'https://x/y?z=1', settings: { name: 'Acme Support (EU)' } }).content).toBe('url: https://x/y?z=1\nname: Acme Support (EU)\n');
  });

  it('never resolves anything but webhookUrl and settings (no secrets)', () => {
    const file: SetupFileDef = { ...json, template: '{"s":"{{secrets.appPassword}}"}' };
    expect(renderSetupFile(file, { webhookUrl: 'https://x', settings: { appPassword: 'leak' } }).content).toBe('{"s":"{{secrets.appPassword}}"}');
  });

  it('fills {{webhookHost}} and previews a zip package by its first text entry, reporting what every entry misses', () => {
    const pkg: SetupFileDef = {
      key: 'pkg',
      label: 'Package',
      filename: 'app.zip',
      contentType: 'application/zip',
      entries: [
        { path: 'manifest.json', contentType: 'application/json', template: '{"id":"{{settings.appId}}","d":["{{webhookHost}}"]}' },
        { path: 'color.png', contentType: 'image/png', base64: 'iVBORw0KGgo=' },
      ],
    };
    const ready = renderSetupFile(pkg, { webhookUrl: 'https://ocso.example.com/channels/ms-teams/k/webhook', settings: { appId: 'a1' } });
    expect(ready).toEqual({ content: '{"id":"a1","d":["ocso.example.com"]}', missing: [], preview: 'manifest.json' });
    expect(renderSetupFile(pkg, { webhookUrl: null, settings: {} }).missing.sort()).toEqual(['settings.appId', 'webhookHost']);
  });

  it('downloads zips through the BFF, renders only https links, and lists the secrets a draft still needs', () => {
    expect(setupFileDownloadHref('0199aaaa-0000-7000-8000-000000000001', 'teams-app-package')).toBe('/api/channels/0199aaaa-0000-7000-8000-000000000001/setup-files/teams-app-package');
    expect(safeHttpsHref('https://api.slack.com/apps')).toBe('https://api.slack.com/apps');
    for (const bad of ['javascript:alert(1)', 'http://example.com', 'https://user:pw@example.com', 'not a url']) expect(safeHttpsHref(bad)).toBeNull();
    const fields = [
      { key: 'botToken', label: 'Bot token', required: true },
      { key: 'signingSecret', label: 'Signing secret', required: true },
      { key: 'visitor', label: 'Visitor', required: true, generate: 'server' },
      { key: 'opt', label: 'Optional', required: false },
    ];
    expect(missingRequiredSecrets(fields, new Set(['signingSecret']))).toEqual(['Bot token']);
  });
});
