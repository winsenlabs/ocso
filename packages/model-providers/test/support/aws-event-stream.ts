import { crc32 } from 'node:zlib';

/**
 * Minimal encoder for the AWS binary event-stream framing used by Bedrock
 * ConverseStream (`application/vnd.amazon.eventstream`):
 *   total_len u32 | headers_len u32 | prelude_crc u32 | headers | payload | message_crc u32
 * Header values are strings (type 7). CRCs are CRC-32 (the SDK verifies them).
 */

const utf8 = new TextEncoder();

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function encodeHeaders(headers: Record<string, string>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = utf8.encode(name);
    const v = utf8.encode(value);
    const len = new Uint8Array(2);
    new DataView(len.buffer).setUint16(0, v.length, false);
    parts.push(Uint8Array.of(n.length), n, Uint8Array.of(7), len, v);
  }
  return concat(parts);
}

export function encodeEventStreamMessage(headers: Record<string, string>, payload: unknown): Uint8Array {
  const h = encodeHeaders(headers);
  const body = utf8.encode(JSON.stringify(payload));
  const total = 12 + h.length + body.length + 4;
  const prelude = concat([u32(total), u32(h.length)]);
  const withoutCrc = concat([prelude, u32(crc32(prelude)), h, body]);
  return concat([withoutCrc, u32(crc32(withoutCrc))]);
}

/** A Bedrock ConverseStream event (`messageStart`, `contentBlockDelta`, `metadata`…). */
export const bedrockEvent = (eventType: string, payload: Record<string, unknown>) =>
  encodeEventStreamMessage(
    { ':event-type': eventType, ':content-type': 'application/json', ':message-type': 'event' },
    { ...payload, p: 'abcdefghij' },
  );

/** A Bedrock in-stream exception (e.g. `throttlingException`). */
export const bedrockException = (exceptionType: string, message: string) =>
  encodeEventStreamMessage(
    { ':exception-type': exceptionType, ':content-type': 'application/json', ':message-type': 'exception' },
    { message },
  );
