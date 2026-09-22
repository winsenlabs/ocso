import { describe, expect, it } from 'vitest';
import { createTeamsAdapter } from '../src/index.js';
import { fakeFetch, message } from './helpers.js';

const HOOK = 'https://prod-00.westeurope.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=SECRETSIG';

interface Card {
  type: string;
  version: string;
  body: Array<{ type: string; text?: string; color?: string; facts?: Array<{ title: string; value: string }> }>;
  actions: Array<{ type: string; title: string; url: string }>;
}

function card(body: unknown): Card {
  const payload = body as { type: string; attachments: Array<{ contentType: string; contentUrl: null; content: Card }> };
  expect(payload.type).toBe('message');
  expect(payload.attachments).toHaveLength(1);
  expect(payload.attachments[0]!.contentType).toBe('application/vnd.microsoft.card.adaptive');
  expect(payload.attachments[0]!.contentUrl).toBeNull();
  return payload.attachments[0]!.content;
}

describe('Teams adapter', () => {
  it('sends an Adaptive Card with severity colour, facts and an Open-in-OCSO action', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 202 }));
    const result = await createTeamsAdapter({ fetch }).deliver(message(), {}, HOOK);
    expect(result).toEqual({ ok: true, retriable: false });
    expect(calls[0]).toMatchObject({ url: HOOK, method: 'POST', redirect: 'error' });
    const c = card(calls[0]!.body);
    expect(c).toMatchObject({ type: 'AdaptiveCard', version: '1.4' });
    expect(c.body[0]).toMatchObject({ type: 'TextBlock', text: '[CRITICAL] Provider error rate above 5% · AWS Bedrock', color: 'Attention' });
    expect(c.body[2]!.facts).toContainEqual({ title: 'Value', value: '8.0%' });
    expect(c.actions).toEqual([{ type: 'Action.OpenUrl', title: 'Open in OCSO', url: message().link }]);
  });

  it('colours resolved alerts "Good" and warnings "Warning"', async () => {
    const { fetch, calls } = fakeFetch();
    const adapter = createTeamsAdapter({ fetch });
    await adapter.deliver(message({ event: 'RESOLVED', status: 'RESOLVED' }), {}, HOOK);
    await adapter.deliver(message({ severity: 'WARNING', link: null }), {}, HOOK);
    expect(card(calls[0]!.body).body[0]!.color).toBe('Good');
    const warning = card(calls[1]!.body);
    expect(warning.body[0]!.color).toBe('Warning');
    expect(warning.actions).toEqual([]);
  });

  it('maps HTTP failures and never reports the workflow URL', async () => {
    const bad = fakeFetch(() => new Response(`Invalid request to ${HOOK}`, { status: 400 }));
    const result = await createTeamsAdapter({ fetch: bad.fetch }).deliver(message(), {}, HOOK);
    expect(result).toMatchObject({ ok: false, retriable: false });
    expect(result.error).not.toContain('SECRETSIG');
    const down = fakeFetch(() => new Response('', { status: 503 }));
    expect(await createTeamsAdapter({ fetch: down.fetch }).deliver(message(), {}, HOOK)).toEqual({ ok: false, retriable: true, error: 'HTTP 503' });
  });

  it('requires an https webhook URL secret', () => {
    const adapter = createTeamsAdapter({ fetch: fakeFetch().fetch });
    expect(adapter.validateSecret('http://example.com/hook')).toHaveLength(1);
    expect(adapter.validateSecret('https://user:pw@example.com/hook')).toEqual(['Teams webhook URL must not contain credentials']);
    expect(adapter.validateSecret(HOOK)).toEqual([]);
  });
});
