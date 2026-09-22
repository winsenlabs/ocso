import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MediaRef } from '@ocso/domain';
import { ChannelMediaError, createTwilioWhatsAppAdapter, isAllowedTwilioMediaHost } from '../src/index.js';
import { streamedBody } from './helpers/whatsapp.js';
import { ACCOUNT_SID, API, API_KEY_SECRET, API_KEY_SID, AUTH_TOKEN, basic, twConfig, twilioFetch } from './helpers/twilio.js';

const MEDIA_URL = `${API}/Messages/MM7d4b1c2a3e5f60718293a4b5c6d7e8f9/Media/ME0a1b2c3d4e5f60718293a4b5c6d7e8f9`;
const CDN_URL = `https://mms.twiliocdn.com/${ACCOUNT_SID}/5c0f6a1e2b3d4c5e6f708192a3b4c5d6?Expires=1758535500&Signature=abc`;
const S3_URL = 'https://s3-external-1.amazonaws.com/media.twiliocdn.com/ACa1/5c0f6a1e?X-Amz-Signature=abc';
const BYTES = new TextEncoder().encode('fake-jpeg-bytes');

const ref = (overrides: Partial<MediaRef> = {}): MediaRef => ({
  status: 'PENDING',
  mimeType: 'image/jpeg',
  source: { channel: 'TWILIO_WHATSAPP', externalId: MEDIA_URL },
  ...overrides,
});

const image = () => new Response(BYTES, { headers: { 'content-type': 'image/jpeg' } });
const redirect = (location: string, status = 307) => new Response(null, { status, headers: { location } });

function setup(respond: (url: string) => Response = (url) => (url === MEDIA_URL ? redirect(CDN_URL) : image())) {
  const { fetch, calls } = twilioFetch(respond);
  return { adapter: createTwilioWhatsAppAdapter({ fetch }), calls };
}

async function mediaError(promise: Promise<unknown>): Promise<ChannelMediaError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ChannelMediaError);
  return error as ChannelMediaError;
}

describe('Twilio media fetch — credentials and redirects', () => {
  it('sends Basic auth to the API host only, then follows the CDN redirect without credentials', async () => {
    const { adapter, calls } = setup();
    const media = await adapter.fetchMedia(ref(), twConfig());
    expect(media).toEqual({ data: BYTES, mimeType: 'image/jpeg', sizeBytes: BYTES.byteLength, sha256: createHash('sha256').update(BYTES).digest('hex'), filename: undefined });
    expect(calls.map((c) => [c.url, c.headers.get('authorization'), c.redirect])).toEqual([
      [MEDIA_URL, basic(ACCOUNT_SID, AUTH_TOKEN), 'manual'],
      [CDN_URL, null, 'manual'],
    ]);
  });

  it('uses the API key for media when one is configured; accepts S3 redirect targets', async () => {
    const { adapter, calls } = setup((url) => (url === MEDIA_URL ? redirect(S3_URL, 302) : image()));
    await adapter.fetchMedia(ref(), twConfig({ apiKeySid: API_KEY_SID }, { apiKeySecret: API_KEY_SECRET }));
    expect(calls[0]?.headers.get('authorization')).toBe(basic(API_KEY_SID, API_KEY_SECRET));
    expect(calls[1]).toMatchObject({ url: S3_URL });
    expect(calls[1]?.headers.get('authorization')).toBeNull();
  });

  it('downloads directly when media auth is off (no redirect)', async () => {
    const { adapter, calls } = setup(() => image());
    await expect(adapter.fetchMedia(ref(), twConfig())).resolves.toMatchObject({ sizeBytes: BYTES.byteLength });
    expect(calls).toHaveLength(1);
  });

  it('refuses media URLs off the Twilio API host before sending anything', async () => {
    const { adapter, calls } = setup();
    for (const url of ['https://attacker.example/2010-04-01/Accounts/x', 'http://api.twilio.com' + MEDIA_URL.slice('https://api.twilio.com'.length), 'https://user:pw@api.twilio.com/x']) {
      expect((await mediaError(adapter.fetchMedia(ref({ source: { channel: 'TWILIO_WHATSAPP', externalId: url } }), twConfig()))).reason, url).toBe('host_not_allowed');
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses references that are not this account's media (other account, other path, other channel)", async () => {
    const { adapter, calls } = setup();
    const otherAccount = MEDIA_URL.replace(ACCOUNT_SID, 'AC00000000000000000000000000000000');
    for (const source of [
      { channel: 'TWILIO_WHATSAPP', externalId: otherAccount },
      { channel: 'TWILIO_WHATSAPP', externalId: `${API}/Messages.json` },
      { channel: 'TWILIO_WHATSAPP', externalId: `${MEDIA_URL}?PageSize=1000` },
      { channel: 'WHATSAPP', externalId: MEDIA_URL },
    ]) {
      expect((await mediaError(adapter.fetchMedia(ref({ source }), twConfig()))).reason, source.externalId).toBe('invalid_reference');
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects redirects to non-Twilio hosts, plain http or odd ports (credentials never follow)', async () => {
    for (const location of ['https://169.254.169.254/latest/meta-data', 'http://mms.twiliocdn.com/x', 'https://mms.twiliocdn.com:8443/x', 'https://twiliocdn.com.evil.io/x', 'https://evil-s3.amazonaws.com.attacker.io/x']) {
      const { adapter, calls } = setup((url) => (url === MEDIA_URL ? redirect(location) : image()));
      expect((await mediaError(adapter.fetchMedia(ref(), twConfig()))).reason, location).toBe('host_not_allowed');
      expect(calls).toHaveLength(1);
    }
  });

  it('allowlists Twilio CDN and S3 hosts only', () => {
    expect(isAllowedTwilioMediaHost(new URL('https://mms.twiliocdn.com/x'))).toBe(true);
    expect(isAllowedTwilioMediaHost(new URL('https://media.twiliocdn.com/x'))).toBe(true);
    expect(isAllowedTwilioMediaHost(new URL('https://s3-external-1.amazonaws.com/x'))).toBe(true);
    expect(isAllowedTwilioMediaHost(new URL('https://bucket.s3.us-east-1.amazonaws.com/x'))).toBe(true);
    for (const bad of ['https://ec2.amazonaws.com/x', 'https://evil.com/x', 'https://twiliocdn.com.evil.io/x', 'http://mms.twiliocdn.com/x']) {
      expect(isAllowedTwilioMediaHost(new URL(bad)), bad).toBe(false);
    }
  });
});

describe('Twilio media fetch — limits', () => {
  it('rejects types outside the channel allowlist before downloading', async () => {
    const { adapter, calls } = setup();
    expect(await mediaError(adapter.fetchMedia(ref({ mimeType: 'application/x-msdownload' }), twConfig()))).toMatchObject({ reason: 'type_not_allowed', rejected: true });
    expect(calls).toHaveLength(0);
  });

  it('rejects oversize media by Content-Length and by streamed byte count', async () => {
    const declared = setup((url) => (url === MEDIA_URL ? redirect(CDN_URL) : new Response(BYTES, { headers: { 'content-type': 'image/jpeg', 'content-length': String(6 * 1024 * 1024) } })));
    expect((await mediaError(declared.adapter.fetchMedia(ref(), twConfig()))).reason).toBe('too_large');
    const streamed = setup((url) => (url === MEDIA_URL ? redirect(CDN_URL) : new Response(streamedBody(5 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/jpeg' } })));
    expect(await mediaError(streamed.adapter.fetchMedia(ref(), twConfig()))).toMatchObject({ reason: 'too_large', rejected: true });
  });

  it('rejects a download whose Content-Type contradicts the declared type', async () => {
    const { adapter } = setup((url) => (url === MEDIA_URL ? redirect(CDN_URL) : new Response('<html>', { headers: { 'content-type': 'text/html' } })));
    expect((await mediaError(adapter.fetchMedia(ref(), twConfig()))).reason).toBe('type_mismatch');
  });

  it('API errors are retriable download failures; too many redirects fail', async () => {
    const { adapter } = setup(() => new Response('nope', { status: 500 }));
    expect(await mediaError(adapter.fetchMedia(ref(), twConfig()))).toMatchObject({ reason: 'download_failed', retriable: true });
    const loop = setup(() => redirect(CDN_URL));
    expect((await mediaError(loop.adapter.fetchMedia(ref(), twConfig()))).reason).toBe('download_failed');
  });
});
