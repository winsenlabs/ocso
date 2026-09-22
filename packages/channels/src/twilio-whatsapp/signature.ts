import { createHmac } from 'node:crypto';
import type { RawHttpRequest, VerificationResult } from '../contract/types.js';
import { equalBytes } from '../common/crypto.js';
import { parseFormPairs, type FormPairs } from './form.js';

/**
 * `X-Twilio-Signature` (PM/research/06 §4): base64(HMAC-SHA1(authToken,
 * url + concat(sorted by name: name + value))). The URL is the one Twilio was
 * configured with — scheme, host, path and query exactly — so OCSO checks the
 * public URL (OCSO_PUBLIC_URL origin + path/query as received), never the
 * proxied internal one. Like twilio-node's validateRequest, the URL is tried
 * without a port and with one (:443 / :80 when none is given).
 */

const SIGNATURE_HEADER = 'x-twilio-signature';
/** 20-byte SHA-1 digest, standard base64. */
const SIGNATURE = /^[A-Za-z0-9+/]{27}=$/;
const URL_PARTS = /^(https?):\/\/([^/?#]+)(.*)$/i;

/**
 * url + every parameter as name + value, names sorted; a repeated name's
 * values are de-duplicated and sorted (exactly twilio-node's
 * getExpectedTwilioSignature / toFormUrlEncodedParam). Default sort order =
 * UTF-16 code units, as `Array.prototype.sort()`.
 */
export function signedPayload(url: string, pairs: FormPairs): string {
  const byName = new Map<string, Set<string>>();
  for (const [name, value] of pairs) byName.set(name, (byName.get(name) ?? new Set()).add(value));
  let data = url;
  for (const name of [...byName.keys()].sort()) {
    for (const value of [...(byName.get(name) ?? [])].sort()) data += name + value;
  }
  return data;
}

export function twilioSignature(authToken: string, url: string, pairs: FormPairs): string {
  return createHmac('sha1', authToken).update(signedPayload(url, pairs), 'utf8').digest('base64');
}

/**
 * The URL variants twilio-node's validateRequest accepts: without any port,
 * and with the port (the explicit one, else :443 / :80). Path and query are
 * kept byte-for-byte, so a trailing-slash or query mismatch still fails.
 * (twilio-node also retries with legacy `querystring` re-encoding of the
 * query; OCSO webhook URLs carry no query, so that variant is not needed.)
 */
export function signatureUrlCandidates(url: string): string[] {
  const match = URL_PARTS.exec(url);
  if (!match) return [url];
  const [, scheme = '', authority = '', rest = ''] = match;
  const host = authority.replace(/:\d+$/, '');
  const port = /:(\d+)$/.exec(authority)?.[1] ?? (scheme.toLowerCase() === 'https' ? '443' : '80');
  return [...new Set([`${scheme}://${host}${rest}`, `${scheme}://${host}:${port}${rest}`])];
}

const rejected = (status: 400 | 401 | 403, reason: string): VerificationResult => ({ kind: 'rejected', status, reason });

export function verifyTwilioSignature(req: RawHttpRequest, authToken: string | undefined): VerificationResult {
  if (req.method !== 'POST') return rejected(400, 'Twilio webhooks must use HTTP POST');
  if (!authToken) return rejected(403, 'auth token not configured');
  const header = req.headers[SIGNATURE_HEADER]?.trim();
  if (!header) return rejected(401, 'missing X-Twilio-Signature header');
  if (!SIGNATURE.test(header)) return rejected(401, 'malformed X-Twilio-Signature header');
  if (!req.url) return rejected(400, 'request URL unavailable for signature verification');
  let pairs: FormPairs;
  try {
    pairs = parseFormPairs(req.rawBody);
  } catch {
    return rejected(400, 'unreadable webhook body');
  }
  const provided = Buffer.from(header, 'base64');
  const valid = signatureUrlCandidates(req.url).some((url) => equalBytes(provided, Buffer.from(twilioSignature(authToken, url, pairs), 'base64')));
  return valid ? { kind: 'verified' } : rejected(403, 'signature mismatch');
}
