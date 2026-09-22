import { describe, expect, it } from 'vitest';
import { createSlackAdapter, type SlackPayload } from '../src/index.js';
import { fakeFetch, message, throwing } from './helpers.js';

const HOOK = 'https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX';
const EMOJI = /\p{Extended_Pictographic}/u;

function setup(respond?: Parameters<typeof fakeFetch>[0]) {
  const { fetch, calls } = fakeFetch(respond);
  return { adapter: createSlackAdapter({ fetch }), calls };
}

describe('Slack adapter', () => {
  it('POSTs a Block Kit message to the webhook URL (the secret) without following redirects', async () => {
    const { adapter, calls } = setup();
    const result = await adapter.deliver(message(), {}, HOOK);
    expect(result).toEqual({ ok: true, retriable: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: HOOK, method: 'POST', redirect: 'error' });
    expect(calls[0]!.headers.get('content-type')).toBe('application/json');
    const payload = calls[0]!.body as SlackPayload;
    expect(payload.text).toBe('Opened: [CRITICAL] Provider error rate above 5% · AWS Bedrock (8.0%)');
    expect(payload.blocks.map((b) => b.type)).toEqual(['header', 'section', 'section', 'context', 'actions']);
    expect(payload.blocks[0]).toEqual({ type: 'header', text: { type: 'plain_text', text: '[CRITICAL] Provider error rate above 5% · AWS Bedrock' } });
    const fields = payload.blocks[2] as { fields: Array<{ text: string }> };
    expect(fields.fields.map((f) => f.text)).toContain('*Severity*\nCritical');
    expect(fields.fields.map((f) => f.text)).toContain('*Source*\nProvider · AWS Bedrock');
    expect(payload.blocks[4]).toMatchObject({ elements: [{ type: 'button', url: message().link }] });
    expect(calls[0]!.rawBody).not.toMatch(EMOJI);
  });

  it('marks resolution in text and escapes mrkdwn control characters', async () => {
    const { adapter, calls } = setup();
    await adapter.deliver(message({ event: 'RESOLVED', status: 'RESOLVED', body: 'queue <b> & co', resolution: 'fixed', link: null }), {}, HOOK);
    const payload = calls[0]!.body as SlackPayload;
    expect(payload.text.startsWith('Resolved: [RESOLVED]')).toBe(true);
    expect(JSON.stringify(payload.blocks[1])).toContain('queue &lt;b&gt; &amp; co\\nResolution: fixed');
    expect(payload.blocks.some((b) => b.type === 'actions')).toBe(false);
  });

  it('maps Slack error responses to retriable / permanent failures without leaking the URL', async () => {
    const cases: Array<[number, string, boolean]> = [
      [404, 'channel_not_found', false],
      [403, 'action_prohibited', false],
      [400, 'invalid_payload', false],
      [429, 'rate_limited', true],
      [500, 'rollup_error', true],
    ];
    for (const [status, text, retriable] of cases) {
      const { adapter } = setup(() => new Response(text, { status }));
      expect(await adapter.deliver(message(), {}, HOOK)).toEqual({ ok: false, retriable, error: `HTTP ${status}: ${text}` });
    }
    const echo = setup(() => new Response(`bad url ${HOOK}`, { status: 400 }));
    const echoed = await echo.adapter.deliver(message(), {}, HOOK);
    expect(echoed.error).not.toContain(HOOK);
  });

  it('treats network errors and timeouts as retriable', async () => {
    expect(await setup(throwing('TypeError')).adapter.deliver(message(), {}, HOOK)).toEqual({ ok: false, retriable: true, error: 'network error' });
    expect(await setup(throwing('TimeoutError')).adapter.deliver(message(), {}, HOOK)).toEqual({ ok: false, retriable: true, error: 'request timed out' });
  });

  it('validates the webhook URL secret and config', async () => {
    const { adapter, calls } = setup();
    expect(adapter.secret?.required).toBe(true);
    expect(adapter.validateSecret('http://hooks.slack.com/x')).toEqual(['Slack webhook URL must use https']);
    expect(adapter.validateSecret('not a url')).toEqual(['Slack webhook URL must be a valid URL']);
    expect(adapter.validateSecret(HOOK)).toEqual([]);
    expect(adapter.validateConfig({ channelLabel: '#alerts' })).toEqual({ ok: true, config: { channelLabel: '#alerts' } });
    expect(adapter.validateConfig({ url: HOOK }).ok).toBe(false);
    expect(await adapter.deliver(message(), {}, null)).toMatchObject({ ok: false, retriable: false });
    expect(calls).toHaveLength(0);
  });
});
