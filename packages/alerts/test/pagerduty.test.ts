import { describe, expect, it } from 'vitest';
import { createPagerDutyAdapter, PAGERDUTY_ENDPOINTS } from '../src/index.js';
import { fakeFetch, message } from './helpers.js';

const KEY = 'R0UT1NGKEY0123456789ABCDEFGHIJKL';
const accepted = (dedup = 'srv-dedup') => new Response(JSON.stringify({ status: 'success', message: 'Event processed', dedup_key: dedup }), { status: 202 });

function setup(respond: Parameters<typeof fakeFetch>[0] = () => accepted()) {
  const { fetch, calls } = fakeFetch(respond);
  return { adapter: createPagerDutyAdapter({ fetch }), calls };
}

describe('PagerDuty adapter (Events API v2)', () => {
  it('triggers with dedup_key = fingerprint, mapped severity and links', async () => {
    const { adapter, calls } = setup();
    const result = await adapter.deliver(message(), { region: 'US' }, KEY);
    expect(result).toEqual({ ok: true, retriable: false, externalId: 'srv-dedup' });
    expect(calls[0]).toMatchObject({ url: PAGERDUTY_ENDPOINTS.US, method: 'POST', redirect: 'error' });
    expect(calls[0]!.body).toMatchObject({
      routing_key: KEY,
      event_action: 'trigger',
      dedup_key: message().fingerprint,
      payload: {
        summary: 'Provider error rate above 5% · AWS Bedrock (8.0%)',
        source: 'Provider · AWS Bedrock',
        severity: 'critical',
        timestamp: message().lastSeenAt,
        group: 'technical',
        class: 'provider_error_rate_above',
        custom_details: { alertId: message().alertId, occurrences: 1, context: { providerId: 'p-1' } },
      },
      client: 'OCSO',
      client_url: message().link,
      links: [{ href: message().link, text: 'Open in OCSO' }],
    });
  });

  it('maps severities and lifecycle events to event actions', async () => {
    const { adapter, calls } = setup();
    await adapter.deliver(message({ severity: 'WARNING' }), { region: 'US' }, KEY);
    await adapter.deliver(message({ severity: 'INFO' }), { region: 'US' }, KEY);
    await adapter.deliver(message({ event: 'ACKNOWLEDGED', status: 'ACKNOWLEDGED' }), { region: 'US' }, KEY);
    await adapter.deliver(message({ event: 'RESOLVED', status: 'RESOLVED' }), { region: 'EU' }, KEY);
    expect((calls[0]!.body as { payload: { severity: string } }).payload.severity).toBe('warning');
    expect((calls[1]!.body as { payload: { severity: string } }).payload.severity).toBe('info');
    expect(calls[2]!.body).toEqual({ routing_key: KEY, event_action: 'acknowledge', dedup_key: message().fingerprint });
    expect(calls[3]!.body).toEqual({ routing_key: KEY, event_action: 'resolve', dedup_key: message().fingerprint });
    expect(calls[3]!.url).toBe(PAGERDUTY_ENDPOINTS.EU);
  });

  it('reports invalid events as permanent failures with the routing key redacted', async () => {
    const body = JSON.stringify({ status: 'invalid event', message: 'Event object is invalid', errors: [`'routing_key' ${KEY} is invalid`] });
    const { adapter } = setup(() => new Response(body, { status: 400 }));
    const result = await adapter.deliver(message(), { region: 'US' }, KEY);
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
    expect(result.error).toContain('HTTP 400: Event object is invalid');
    expect(result.error).not.toContain(KEY);
  });

  it('retries on throttling and server errors', async () => {
    expect((await setup(() => new Response('{}', { status: 429 })).adapter.deliver(message(), { region: 'US' }, KEY)).retriable).toBe(true);
    expect((await setup(() => new Response('', { status: 500 })).adapter.deliver(message(), { region: 'US' }, KEY)).retriable).toBe(true);
  });

  it('validates config and routing key', () => {
    const { adapter } = setup();
    expect(adapter.validateConfig({})).toEqual({ ok: true, config: { region: 'US' } });
    expect(adapter.validateConfig({ region: 'APAC' }).ok).toBe(false);
    expect(adapter.validateSecret('short')).toHaveLength(1);
    expect(adapter.validateSecret(KEY)).toEqual([]);
  });
});
