/** HTTP helpers for bounded, safe downloads. */

export class BodyTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`response body exceeds ${limitBytes} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

/** Declared Content-Length, or null when absent/unparseable. */
export function declaredContentLength(response: Response): number | null {
  const raw = response.headers.get('content-length');
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

/**
 * Read a response body, aborting as soon as more than `limitBytes` arrive.
 * Never trusts Content-Length alone: the streamed byte count is enforced.
 */
export async function readBodyWithLimit(response: Response, limitBytes: number): Promise<Uint8Array> {
  const body = response.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(limitBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Release a response body we are not going to read. */
export async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}
