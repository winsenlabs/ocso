/**
 * Minimal, allocation-light Server-Sent Events parser (WHATWG "event stream"
 * format) shared by the browser hook and the /api/realtime proxy. Feed it
 * decoded text chunks; it returns complete events and keeps the remainder.
 */

export interface SseMessage {
  event: string;
  data: string;
  id: string | null;
}

export class SseParser {
  private buffer = '';

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    for (;;) {
      const match = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer);
      if (!match) break;
      const block = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const message = parseBlock(block);
      if (message) out.push(message);
    }
    return out;
  }
}

/** One event block → message; comment-only blocks (": keepalive") yield null. */
export function parseBlock(block: string): SseMessage | null {
  let event = 'message';
  let id: string | null = null;
  const data: string[] = [];
  let sawField = false;
  for (const line of block.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    sawField = true;
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }
  return sawField ? { event, data: data.join('\n'), id } : null;
}

/** Serialize an event block (used when the proxy re-emits filtered events). */
export function formatBlock(message: SseMessage): string {
  const lines = [`event: ${message.event}`];
  if (message.id) lines.push(`id: ${message.id}`);
  for (const line of message.data.split('\n')) lines.push(`data: ${line}`);
  return `${lines.join('\n')}\n\n`;
}
