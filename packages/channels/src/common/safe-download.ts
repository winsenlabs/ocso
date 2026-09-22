import { ChannelMediaError } from './errors.js';
import { BodyTooLargeError, declaredContentLength, discardBody, isTimeoutError, readBodyWithLimit } from './http.js';
import { baseMimeType } from './mime.js';
import type { ChannelFetch } from '../contract/types.js';

/**
 * SSRF-safe provider media download shared by channel adapters. Redirects are
 * followed manually and every hop is re-checked against the adapter's host
 * policy; credentials are attached per hop by the adapter (so they only ever
 * reach hosts it trusts). Size is enforced by Content-Length and by the
 * streamed byte count; a specific Content-Type that contradicts the declared
 * type is rejected.
 */

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const GENERIC_CONTENT_TYPES: ReadonlySet<string> = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

export interface SafeDownloadOptions {
  fetch: ChannelFetch;
  limitBytes: number;
  timeoutMs: number;
  /** Declared MIME type; a specific, different Content-Type is rejected. */
  expectedMimeType: string;
  /** Host policy for the first URL and every redirect hop. */
  isAllowed: (url: URL) => boolean;
  /** Request headers for one hop; credentials only for hosts that should see them. */
  headersFor: (url: URL) => Record<string, string>;
  /** e.g. "WhatsApp media host", used in the rejection message. */
  hostLabel: string;
}

function allowedUrl(value: string, base: URL | undefined, options: SafeDownloadOptions): URL {
  const url = URL.canParse(value, base) ? new URL(value, base) : null;
  if (!url || url.username || url.password || !options.isAllowed(url)) {
    throw new ChannelMediaError('host_not_allowed', `media URL host is not an allowed ${options.hostLabel}`, {
      host: url?.hostname ?? null,
    });
  }
  return url;
}

function checkResponseHeaders(response: Response, options: SafeDownloadOptions): void {
  const declared = declaredContentLength(response);
  if (declared !== null && declared > options.limitBytes) {
    throw new ChannelMediaError('too_large', `media exceeds ${options.limitBytes} bytes`, { declaredBytes: declared });
  }
  const contentType = baseMimeType(response.headers.get('content-type') ?? '');
  if (!GENERIC_CONTENT_TYPES.has(contentType) && contentType !== baseMimeType(options.expectedMimeType)) {
    throw new ChannelMediaError('type_mismatch', 'downloaded media type differs from the declared type', {
      declared: baseMimeType(options.expectedMimeType),
      received: contentType,
    });
  }
}

async function readLimited(response: Response, limitBytes: number): Promise<Uint8Array> {
  try {
    return await readBodyWithLimit(response, limitBytes);
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new ChannelMediaError('too_large', `media exceeds ${limitBytes} bytes`);
    throw error;
  }
}

async function downloadHops(start: string, options: SafeDownloadOptions, signal: AbortSignal): Promise<Uint8Array> {
  let url = allowedUrl(start, undefined, options);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await options.fetch(url, { method: 'GET', headers: options.headersFor(url), redirect: 'manual', signal });
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      await discardBody(response);
      if (!location) throw new ChannelMediaError('download_failed', 'media redirect without a location');
      url = allowedUrl(location, url, options);
      continue;
    }
    if (!response.ok) {
      await discardBody(response);
      throw new ChannelMediaError('download_failed', `media download failed with HTTP ${response.status}`, {
        status: response.status,
      });
    }
    try {
      checkResponseHeaders(response, options);
    } catch (error) {
      await discardBody(response);
      throw error;
    }
    return readLimited(response, options.limitBytes);
  }
  throw new ChannelMediaError('download_failed', 'too many media redirects');
}

export async function safeDownload(url: string, options: SafeDownloadOptions): Promise<Uint8Array> {
  try {
    return await downloadHops(url, options, AbortSignal.timeout(options.timeoutMs));
  } catch (error) {
    if (error instanceof ChannelMediaError) throw error;
    if (isTimeoutError(error)) throw new ChannelMediaError('timeout', 'media download timed out');
    throw new ChannelMediaError('download_failed', 'media download failed before completion');
  }
}
