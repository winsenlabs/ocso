import { failed, type DeliveryResult } from './contract.js';

/** Minimal fetch signature so callers can inject an SSRF-guarded fetch or a test fake. */
export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 4_096;
const RETRIABLE_STATUS: ReadonlySet<number> = new Set([408, 425, 429]);

/** Transient HTTP failures worth retrying: 408/425/429 and every 5xx. */
export function isRetriableStatus(status: number): boolean {
  return RETRIABLE_STATUS.has(status) || status >= 500;
}

export interface HttpRequest {
  url: string;
  body: string;
  headers?: Readonly<Record<string, string>> | undefined;
  timeoutMs?: number | undefined;
}

export type HttpOutcome =
  | { kind: 'response'; status: number; text: string }
  | { kind: 'error'; reason: 'timeout' | 'network' };

/** POST a JSON body. Never follows redirects; never throws for transport failures. */
export async function postJson(fetchFn: FetchFn, request: HttpRequest): Promise<HttpOutcome> {
  try {
    const response = await fetchFn(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'OCSO-Alerts/1', ...request.headers },
      body: request.body,
      redirect: 'error',
      signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    return { kind: 'response', status: response.status, text: await readSmallText(response) };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return { kind: 'error', reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' };
  }
}

async function readSmallText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, MAX_RESPONSE_CHARS);
  } catch {
    return '';
  }
}

/** Replace any occurrence of the given secrets (e.g. a webhook URL or routing key) in a string. */
export function redactSecrets(text: string, secrets: ReadonlyArray<string | null | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/**
 * Map an HTTP outcome to a DeliveryResult. `detail` may add a short provider
 * reason (already redacted by the caller). The request URL is never included.
 */
export function resultFromHttp(outcome: HttpOutcome, detail?: (status: number, text: string) => string | undefined): DeliveryResult {
  if (outcome.kind === 'error') return failed(true, outcome.reason === 'timeout' ? 'request timed out' : 'network error');
  if (outcome.status >= 200 && outcome.status < 300) return { ok: true, retriable: false };
  const extra = detail?.(outcome.status, outcome.text);
  return failed(isRetriableStatus(outcome.status), `HTTP ${outcome.status}${extra ? `: ${extra}` : ''}`);
}

/** A short, safe token from a provider error body (e.g. Slack's `channel_not_found`). */
export function safeToken(text: string, max = 120): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return /^[\w .,:'"()\-/]+$/.test(trimmed) ? trimmed.slice(0, max) : undefined;
}
