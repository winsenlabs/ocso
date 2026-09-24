import { describe, expect, it } from 'vitest';
import { renderSetupFile, type SetupFileDef } from '@/components/connections/channels/settings-form';

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
});
