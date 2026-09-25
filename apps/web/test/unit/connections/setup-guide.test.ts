import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SetupFileList, SetupGuide, Troubleshooting } from '@/components/connections/channels/setup-guide';

// The API schemas live next to the server-only client; parsing needs neither.
vi.mock('server-only', () => ({}));
vi.mock('../../../lib/api/client', () => ({ api: {} }));
const { ChannelKindSchema } = await import('../../../lib/api/channels');
import type { SetupFileDef } from '@/components/connections/channels/settings-form';

const CHANNEL = '0199aaaa-0000-7000-8000-000000000001';
const URL_ = 'https://ocso.example.com/channels/slack/k_1/webhook';

const manifest: SetupFileDef = { key: 'slack-app-manifest', label: 'Slack app manifest (JSON)', filename: 'slack-app-manifest.json', contentType: 'application/json', template: '{"request_url":"{{webhookUrl}}"}' };
const pkg: SetupFileDef = {
  key: 'teams-app-package',
  label: 'Teams app package',
  filename: 'ocso-teams-app.zip',
  contentType: 'application/zip',
  entries: [{ path: 'manifest.json', contentType: 'application/json', template: '{"id":"{{settings.appId}}"}' }],
};

const steps = [
  { title: 'Create the Slack app from the manifest', body: 'Paste it.', files: ['slack-app-manifest'], values: [{ label: 'Request URL', value: '{{webhookUrl}}' }], links: [{ label: 'Your Slack apps', href: 'https://api.slack.com/apps' }, { label: 'Evil', href: 'javascript:alert(1)' }] },
  { title: 'Review the bot token scopes', body: 'These:', table: { head: ['Scope', 'Why OCSO needs it'] as [string, string], rows: [['chat:write', 'Post replies.'] as [string, string]] } },
  { title: 'Paste them into OCSO and save', body: 'Enter both.', form: true, check: 'Both are set.' },
];

const render = (node: (props: any) => unknown, props: Record<string, unknown>) => renderToStaticMarkup(createElement(node as never, props as never));

describe('channel setup guide (descriptor setupGuide in the channel dialog)', () => {
  it('renders a numbered checklist with values to copy, files, the scopes table, https links only and the form in its step', () => {
    const html = render(SetupGuide, { steps, files: [manifest], ctx: { webhookUrl: URL_, settings: {} }, channelId: CHANNEL, label: 'Slack', formSlot: createElement('div', { id: 'the-form' }, 'FORM') });
    expect(html).toContain('aria-label="Slack setup guide"');
    expect(html.match(/class="cg-step"/g)).toHaveLength(3);
    expect(html).toContain('Mark step 1 done');
    expect(html).toContain(`<code class="secret-once" aria-label="Request URL">${URL_}</code>`);
    expect(html).toContain('aria-label="Copy Request URL"');
    // The manifest, filled with the webhook URL, with copy and download.
    expect(html).toContain(`{&quot;request_url&quot;:&quot;${URL_}&quot;}`);
    expect(html).toContain('aria-label="Download Slack app manifest (JSON)"');
    expect(html).toContain('<th scope="col">Why OCSO needs it</th>');
    expect(html).toContain('<code class="mono">chat:write</code>');
    expect(html).toContain('href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer"');
    expect(html).not.toContain('javascript:');
    // OCSO's form sits inside the step marked `form`, after its body.
    expect(html.indexOf('id="the-form"')).toBeGreaterThan(html.indexOf('Paste them into OCSO and save'));
    expect(html).toContain('✓ Both are set.');
  });

  it('before the channel exists, values that need it say so instead of showing a placeholder', () => {
    const html = render(SetupGuide, { steps, files: [manifest], ctx: { webhookUrl: null, settings: {} }, channelId: null, label: 'Slack' });
    expect(html).toContain('available once the channel is saved');
    expect(html).not.toContain('aria-label="Copy Request URL"');
    expect(html).toContain('Save the channel first');
  });

  it('offers a zip package as a download from the API once its values are saved, disabled before', () => {
    const ready = render(SetupFileList, { files: [pkg], ctx: { webhookUrl: URL_, settings: { appId: 'a1' } }, channelId: CHANNEL });
    expect(ready).toContain(`href="/api/channels/${CHANNEL}/setup-files/teams-app-package"`);
    expect(ready).toContain('download="ocso-teams-app.zip"');
    expect(ready).toContain('Preview manifest.json (inside the zip, with its icons)');
    const waiting = render(SetupFileList, { files: [pkg], ctx: { webhookUrl: URL_, settings: {} }, channelId: CHANNEL });
    expect(waiting).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Download Teams app package"/);
    expect(waiting).toContain('Fill in appId and save before using this file.');
  });

  it('lists troubleshooting entries with anchors a connection check can link to', () => {
    const html = render(Troubleshooting, { entries: [{ id: 'missing-scope', problem: 'Slack answers missing_scope', fix: 'Reinstall the app.' }], open: false, onToggle: () => {} });
    expect(html).toContain('id="ts-missing-scope"');
    expect(html).toContain('<dt>Slack answers missing_scope</dt>');
    expect(html).toContain('Troubleshooting · 1 known problems');
  });

  it('parses kinds leniently: a bad guide or file list from a newer plugin degrades to none', () => {
    const kind = ChannelKindSchema.parse({ kind: 'X', setupGuide: [{ title: 'T' }], troubleshooting: 'nope', setupFiles: [{ key: 'k', label: 'L', filename: 'f.zip', contentType: 'application/zip', entries: [] }] });
    expect(kind.setupGuide).toEqual([{ title: 'T', body: '' }]);
    expect(kind.troubleshooting).toEqual([]);
    expect(kind.setupFiles[0]?.contentType).toBe('application/zip');
  });
});
