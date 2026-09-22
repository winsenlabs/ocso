import type { MediaRef } from '@ocso/domain';
import type { ChannelCapabilities, FetchedMedia } from '../contract/types.js';
import { sha256Hex } from '../common/crypto.js';
import { ChannelMediaError } from '../common/errors.js';
import { mediaKindForMime } from '../common/mime.js';
import { safeDownload } from '../common/safe-download.js';
import type { ResolvedTwilioConfig } from './config.js';
import { TWILIO_MEDIA_SOURCE } from './inbound/content-parts.js';
import { basicAuthorization } from './rest-client.js';

/**
 * Inbound media fetch (PM/research/06 §7). The webhook's MediaUrl is
 * `…/2010-04-01/Accounts/{AC}/Messages/{MM|SM}/Media/{ME}` on the API host,
 * which enforces HTTP Basic auth on new accounts and answers with a redirect
 * to a short-lived signed CDN URL. Credentials go ONLY to the configured API
 * origin; redirect hops are followed manually, without credentials, over
 * https on the default port to Twilio's media CDN / S3 hosts only. MIME
 * allowlist and per-kind size caps apply (declared, Content-Length, streamed).
 */

const MEDIA_PATH = /^\/2010-04-01\/Accounts\/(AC[0-9a-fA-F]{32})\/Messages\/[A-Z]{2}[0-9a-fA-F]{32}\/Media\/ME[0-9a-fA-F]{32}$/;
/** Redirect targets (community-reported, research/06 §7): Twilio's media CDN and the S3 endpoints behind it. */
export const TWILIO_MEDIA_HOST_SUFFIXES: readonly string[] = ['twiliocdn.com', 'twilio.com'];
const S3_HOST = /^(?:[a-z0-9-]+\.)*s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/;

/** A redirect hop Twilio may send media from: https, default port, Twilio CDN or S3. */
export function isAllowedTwilioMediaHost(url: URL): boolean {
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return TWILIO_MEDIA_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)) || S3_HOST.test(host);
}

export interface TwilioMediaContext {
  config: ResolvedTwilioConfig;
  fetch: typeof fetch;
  capabilities: ChannelCapabilities;
}

/** The media URL, checked to be this account's media on the configured API origin. */
function mediaUrlOf(ref: MediaRef, config: ResolvedTwilioConfig): URL {
  const raw = ref.source?.externalId;
  if (ref.source?.channel !== TWILIO_MEDIA_SOURCE || !raw || !URL.canParse(raw)) {
    throw new ChannelMediaError('invalid_reference', 'media reference is not a Twilio media URL');
  }
  const url = new URL(raw);
  if (url.origin !== new URL(config.settings.apiBaseUrl).origin || url.username || url.password) {
    throw new ChannelMediaError('host_not_allowed', 'media URL is not on the Twilio API host', { host: url.hostname });
  }
  const account = MEDIA_PATH.exec(url.pathname)?.[1];
  if (!account || account.toLowerCase() !== config.settings.accountSid.toLowerCase() || url.search || url.hash) {
    throw new ChannelMediaError('invalid_reference', "media URL is not this account's Twilio media");
  }
  return url;
}

export async function fetchTwilioMedia(ref: MediaRef, ctx: TwilioMediaContext): Promise<FetchedMedia> {
  const url = mediaUrlOf(ref, ctx.config);
  const kind = mediaKindForMime(ctx.capabilities, ref.mimeType);
  if (!kind) throw new ChannelMediaError('type_not_allowed', 'media type is not allowed on this channel', { mimeType: ref.mimeType });
  const limitBytes = ctx.capabilities.maxMediaBytes[kind];
  if ((ref.sizeBytes ?? 0) > limitBytes) {
    throw new ChannelMediaError('too_large', `media exceeds ${limitBytes} bytes`, { declaredBytes: ref.sizeBytes, kind });
  }
  const apiOrigin = url.origin;
  const authorization = basicAuthorization(ctx.config);
  const data = await safeDownload(url.toString(), {
    fetch: ctx.fetch,
    limitBytes,
    timeoutMs: ctx.config.settings.mediaDownloadTimeoutMs,
    expectedMimeType: ref.mimeType,
    isAllowed: (hop) => hop.origin === apiOrigin || isAllowedTwilioMediaHost(hop),
    headersFor: (hop): Record<string, string> => (hop.origin === apiOrigin ? { authorization } : {}),
    hostLabel: 'Twilio media host',
  });
  return { data, mimeType: ref.mimeType, sizeBytes: data.byteLength, sha256: sha256Hex(data), filename: ref.filename };
}
