import { safeDownload } from '../common/safe-download.js';

/**
 * Step 2 of a WhatsApp media fetch: download bytes from Meta's CDN with the
 * bearer token. The token is only ever sent to allowlisted hosts; redirects
 * are followed manually and every hop is re-checked (SSRF / token-leak guard,
 * ported from the MIT-licensed @chat-adapter/whatsapp `isWhatsAppMediaUrl`).
 */

export const WHATSAPP_MEDIA_HOST_SUFFIXES: readonly string[] = ['fbcdn.net', 'fbsbx.com'];

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

export interface DownloadOptions {
  fetch: typeof fetch;
  accessToken: string;
  graphOrigin: string;
  limitBytes: number;
  timeoutMs: number;
  /** Declared MIME type; a specific, different Content-Type is rejected. */
  expectedMimeType: string;
}

export function downloadMedia(url: string, options: DownloadOptions): Promise<Uint8Array> {
  return safeDownload(url, {
    fetch: options.fetch,
    limitBytes: options.limitBytes,
    timeoutMs: options.timeoutMs,
    expectedMimeType: options.expectedMimeType,
    isAllowed: (hop) => isAllowedMediaUrl(hop, options.graphOrigin),
    headersFor: () => ({ authorization: `Bearer ${options.accessToken}` }),
    hostLabel: 'WhatsApp media host',
  });
}
