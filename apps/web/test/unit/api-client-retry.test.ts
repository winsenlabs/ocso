import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));

const { api } = await import('../../lib/api/client');

/**
 * The api container restarts on every upgrade. A page loaded in that second
 * used to render "OCSO could not reach its API"; reads retry instead. Writes
 * never do — OCSO cannot know whether the API applied them.
 */
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const schema = z.object({ ok: z.boolean() });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('api client', () => {
  it('retries a GET that never reached the API, then returns the response', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))
      .mockResolvedValueOnce(ok({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.get('/v1/telemetry/overview', schema)).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps trying for a few seconds, then gives up with an unreachable error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    vi.stubGlobal('fetch', fetchMock);
    const started = Date.now();
    await expect(api.get('/v1/telemetry/overview', schema)).rejects.toMatchObject({ code: 'api_unreachable' });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(Date.now() - started).toBeGreaterThanOrEqual(5_000);
  }, 20_000);

  it('does not repeat a read that timed out: the API may have received it', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException('The operation was aborted', 'TimeoutError'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.get('/v1/telemetry/overview', schema)).rejects.toMatchObject({ code: 'api_timeout' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never repeats a write', async () => {
    const fetchMock = vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.post('/v1/conversations/1/messages', { text: 'hi' }, schema)).rejects.toMatchObject({ code: 'api_unreachable' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
