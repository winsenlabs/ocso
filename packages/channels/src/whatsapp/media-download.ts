import { ChannelMediaError } from '../common/errors.js';
import { BodyTooLargeError, declaredContentLength, discardBody, isTimeoutError, readBodyWithLimit } from '../common/http.js';
import { baseMimeType } from '../common/mime.js';

/**
 * Step 2 of a WhatsApp media fetch: download bytes from Meta's CDN with the
 * bearer token. The token is only ever sent to allowlisted hosts; redirects
 * are followed manually and every hop is re-checked (SSRF / token-leak guard,
 * ported from the MIT-licensed @chat-adapter/whatsapp `isWhatsAppMediaUrl`).
 */

export const WHATSAPP_MEDIA_HOST_SUFFIXES: readonly string[] = ['fbcdn.net', 'fbsbx.com'];
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const GENERIC_CONTENT_TYPES: ReadonlySet<string> = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/** Meta CDN over https on the default port, or the configured Graph origin itself. */
export function isAllowedMediaUrl(url: URL, graphOrigin: string): boolean {
  if (url.username || url.password) return false;
  if (url.origin === graphOrigin) return true;
  return (
    url.protocol === 'https:' &&
    url.port === '' &&
    WHATSAPP_MEDIA_HOST_SUFFIXES.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
  );
}

function allowedUrl(value: string, base: URL | undefined, graphOrigin: string): URL {
  const url = URL.canParse(value, base) ? new URL(value, base) : null;
  if (!url || !isAllowedMediaUrl(url, graphOrigin)) {
    throw new ChannelMediaError('host_not_allowed', 'media URL host is not an allowed WhatsApp media host', {
      host: url?.hostname ?? null,
    });
  }
  return url;
}

export interface DownloadOptions {
  fetch: typeof fetch;
  accessToken: string;
  graphOrigin: string;
  limitBytes: number;
  timeoutMs: number;
  /** Declared MIME type; a specific, different Content-Type is rejected. */
  expectedMimeType: string;
}

function checkResponseHeaders(response: Response, options: DownloadOptions): void {
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

async function downloadHops(start: string, options: DownloadOptions, signal: AbortSignal): Promise<Uint8Array> {
  let url = allowedUrl(start, undefined, options.graphOrigin);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await options.fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${options.accessToken}` },
      redirect: 'manual',
      signal,
    });
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      await discardBody(response);
      if (!location) throw new ChannelMediaError('download_failed', 'media redirect without a location');
      url = allowedUrl(location, url, options.graphOrigin);
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

export async function downloadMedia(url: string, options: DownloadOptions): Promise<Uint8Array> {
  try {
    return await downloadHops(url, options, AbortSignal.timeout(options.timeoutMs));
  } catch (error) {
    if (error instanceof ChannelMediaError) throw error;
    if (isTimeoutError(error)) throw new ChannelMediaError('timeout', 'media download timed out');
    throw new ChannelMediaError('download_failed', 'media download failed before completion');
  }
}
