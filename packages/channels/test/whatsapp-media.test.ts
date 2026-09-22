import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MediaRef } from '@ocso/domain';
import { ChannelMediaError, createWhatsAppAdapter, isAllowedMediaUrl } from '../src/index.js';
import { ACCESS_TOKEN, fakeFetch, GRAPH, graphError, json, streamedBody, waConfig } from './helpers/whatsapp.js';

const MEDIA_ID = '1003383421387256';
const CDN_URL = `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${MEDIA_ID}&ext=1758535500&hash=ATsZ`;
const BYTES = new TextEncoder().encode('fake-jpeg-bytes');
const HEX = createHash('sha256').update(BYTES).digest('hex');
const B64 = createHash('sha256').update(BYTES).digest('base64');

const ref = (overrides: Partial<MediaRef> = {}): MediaRef => ({
  status: 'PENDING',
  mimeType: 'image/jpeg',
  source: { channel: 'WHATSAPP', externalId: MEDIA_ID },
  ...overrides,
});

interface Scenario {
  info?: Record<string, unknown>;
  infoResponse?: Response;
  download?: (url: string) => Response;
}

function setup(scenario: Scenario = {}) {
  const { fetch, calls } = fakeFetch((url) => {
    if (url === `${GRAPH}/${MEDIA_ID}`) {
      return (
        scenario.infoResponse ??
        json({ messaging_product: 'whatsapp', url: CDN_URL, mime_type: 'image/jpeg', sha256: HEX, file_size: BYTES.byteLength, id: MEDIA_ID, ...scenario.info })
      );
    }
    return scenario.download?.(url) ?? new Response(BYTES, { headers: { 'content-type': 'image/jpeg' } });
  });
  return { adapter: createWhatsAppAdapter({ fetch }), calls };
}

async function mediaError(promise: Promise<unknown>): Promise<ChannelMediaError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ChannelMediaError);
  return error as ChannelMediaError;
}

describe('WhatsApp media fetch — happy path', () => {
  it('looks up the media URL, downloads with the bearer token and verifies sha256', async () => {
    const { adapter, calls } = setup();
    const media = await adapter.fetchMedia(ref({ sha256: HEX, filename: 'receipt.jpg' }), waConfig());
    expect(media).toEqual({ data: BYTES, mimeType: 'image/jpeg', sizeBytes: BYTES.byteLength, sha256: HEX, filename: 'receipt.jpg' });
    expect(calls.map((c) => c.url)).toEqual([`${GRAPH}/${MEDIA_ID}`, CDN_URL]);
    expect(calls.every((c) => c.headers.get('authorization') === `Bearer ${ACCESS_TOKEN}`)).toBe(true);
    expect(calls[1]?.redirect).toBe('manual');
  });

  it('accepts base64 digests (as Meta webhooks send them)', async () => {
    const { adapter } = setup({ info: { sha256: B64 } });
    await expect(adapter.fetchMedia(ref({ sha256: HEX }), waConfig())).resolves.toMatchObject({ sha256: HEX });
  });

  it('follows a redirect that stays on an allowed Meta host', async () => {
    const hop = 'https://scontent.xx.fbcdn.net/v/t61/abc.jpg';
    const { adapter, calls } = setup({
      download: (url) =>
        url === CDN_URL ? new Response(null, { status: 302, headers: { location: hop } }) : new Response(BYTES, { headers: { 'content-type': 'image/jpeg' } }),
    });
    await expect(adapter.fetchMedia(ref(), waConfig())).resolves.toMatchObject({ sizeBytes: BYTES.byteLength });
    expect(calls.map((c) => c.url)).toEqual([`${GRAPH}/${MEDIA_ID}`, CDN_URL, hop]);
  });
});

describe('WhatsApp media fetch — safety', () => {
  it('rejects a download URL on a non-Meta host without sending the token there', async () => {
    const { adapter, calls } = setup({ info: { url: 'https://attacker.example/steal' } });
    const error = await mediaError(adapter.fetchMedia(ref(), waConfig()));
    expect(error).toMatchObject({ reason: 'host_not_allowed', rejected: true });
    expect(calls.map((c) => c.url)).toEqual([`${GRAPH}/${MEDIA_ID}`]);
  });

  it('rejects look-alike hosts, plain http and non-default ports', () => {
    const origin = 'https://graph.facebook.com';
    for (const bad of ['https://fbsbx.com.evil.io/x', 'https://evilfbcdn.net/x', 'http://lookaside.fbsbx.com/x', 'https://lookaside.fbsbx.com:8443/x', 'https://user:pw@lookaside.fbsbx.com/x']) {
      expect(isAllowedMediaUrl(new URL(bad), origin), bad).toBe(false);
    }
    expect(isAllowedMediaUrl(new URL('https://lookaside.fbsbx.com/x'), origin)).toBe(true);
    expect(isAllowedMediaUrl(new URL('https://graph.facebook.com/v26.0/x'), origin)).toBe(true);
  });

  it('rejects a redirect to a non-allowed host (token never follows)', async () => {
    const { adapter, calls } = setup({
      download: () => new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } }),
    });
    const error = await mediaError(adapter.fetchMedia(ref(), waConfig()));
    expect(error.reason).toBe('host_not_allowed');
    expect(calls).toHaveLength(2);
  });

  it('rejects oversize media by declared file_size before downloading', async () => {
    const { adapter, calls } = setup({ info: { file_size: 6 * 1024 * 1024 } });
    const error = await mediaError(adapter.fetchMedia(ref(), waConfig()));
    expect(error).toMatchObject({ reason: 'too_large', rejected: true, retriable: false });
    expect(calls).toHaveLength(1);
  });

  it('rejects oversize media by Content-Length', async () => {
    const { adapter } = setup({
      info: { file_size: undefined },
      download: () => new Response(BYTES, { headers: { 'content-type': 'image/jpeg', 'content-length': String(6 * 1024 * 1024) } }),
    });
    expect((await mediaError(adapter.fetchMedia(ref(), waConfig()))).reason).toBe('too_large');
  });

  it('rejects oversize media by streamed byte count when Content-Length is absent or lies', async () => {
    const { adapter } = setup({
      info: { file_size: 100, sha256: undefined },
      download: () => new Response(streamedBody(5 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/jpeg' } }),
    });
    expect((await mediaError(adapter.fetchMedia(ref(), waConfig()))).reason).toBe('too_large');
  });

  it('rejects MIME types outside the channel allowlist', async () => {
    const { adapter, calls } = setup({ info: { mime_type: 'application/x-msdownload' } });
    const error = await mediaError(adapter.fetchMedia(ref({ mimeType: 'application/x-msdownload' }), waConfig()));
    expect(error).toMatchObject({ reason: 'type_not_allowed', rejected: true });
    expect(calls).toHaveLength(1);
  });

  it('rejects a download whose Content-Type contradicts the declared type', async () => {
    const { adapter } = setup({ download: () => new Response('<html>', { headers: { 'content-type': 'text/html' } }) });
    expect((await mediaError(adapter.fetchMedia(ref(), waConfig()))).reason).toBe('type_mismatch');
  });

  it('rejects a sha256 mismatch against the webhook digest', async () => {
    const { adapter } = setup({ info: { sha256: undefined } });
    const error = await mediaError(adapter.fetchMedia(ref({ sha256: 'a'.repeat(64) }), waConfig()));
    expect(error).toMatchObject({ reason: 'checksum_mismatch', rejected: true });
  });

  it('rejects a sha256 mismatch against the Graph digest', async () => {
    const { adapter } = setup({ info: { sha256: 'b'.repeat(64) } });
    expect((await mediaError(adapter.fetchMedia(ref(), waConfig()))).reason).toBe('checksum_mismatch');
  });

  it('rejects references that are not WhatsApp media ids (no path injection)', async () => {
    const { adapter, calls } = setup();
    for (const source of [{ channel: 'WEBCHAT', externalId: MEDIA_ID }, { channel: 'WHATSAPP', externalId: '../me/accounts' }]) {
      expect((await mediaError(adapter.fetchMedia(ref({ source }), waConfig()))).reason).toBe('invalid_reference');
    }
    expect(calls).toHaveLength(0);
  });
});

describe('WhatsApp media fetch — provider failures', () => {
  it('expired/unknown media id is not_found (not retriable)', async () => {
    const { adapter } = setup({ infoResponse: graphError(400, 100, 'Unsupported get request') });
    expect(await mediaError(adapter.fetchMedia(ref(), waConfig()))).toMatchObject({ reason: 'not_found', retriable: false });
  });

  it('rate limiting and CDN errors are retriable; auth failures are not', async () => {
    const limited = setup({ infoResponse: graphError(429, 130429, 'Rate limit hit') });
    expect(await mediaError(limited.adapter.fetchMedia(ref(), waConfig()))).toMatchObject({ reason: 'rate_limited', retriable: true });
    const cdn = setup({ download: () => new Response('gone', { status: 404 }) });
    expect(await mediaError(cdn.adapter.fetchMedia(ref(), waConfig()))).toMatchObject({ reason: 'download_failed', retriable: true });
    const auth = setup({ infoResponse: graphError(401, 190, 'Error validating access token') });
    expect(await mediaError(auth.adapter.fetchMedia(ref(), waConfig()))).toMatchObject({ reason: 'auth_failed', retriable: false });
  });

  it('error messages and details never include the access token', async () => {
    const { adapter } = setup({ infoResponse: graphError(401, 190, `Invalid OAuth access token ${ACCESS_TOKEN}`) });
    const error = await mediaError(adapter.fetchMedia(ref(), waConfig()));
    expect(`${error.message} ${JSON.stringify(error.details)}`).not.toContain(ACCESS_TOKEN);
  });
});
