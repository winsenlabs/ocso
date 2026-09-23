import { createHash } from 'node:crypto';
import type { LanguageModelV4CallOptions, LanguageModelV4Usage } from '@ai-sdk/provider';

/**
 * Synthetic usage for the dev-scripted model, including a prompt-cache
 * simulation so cache telemetry is demoable: the prefix up to each cache
 * marker is hashed; the longest previously seen prefix counts as a cache
 * read, the rest up to the last marker as a cache write (Anthropic-like).
 */

export const DEV_PROVIDER_OPTIONS_KEY = 'devScripted';

const estimateTokens = (s: string) => Math.ceil(s.length / 4);
const FILE_TOKENS = 256;

interface Segment {
  text: string;
  marked: boolean;
}

const hasMarker = (providerOptions: unknown) =>
  typeof providerOptions === 'object' && providerOptions !== null && DEV_PROVIDER_OPTIONS_KEY in providerOptions;

/** Flatten the call into ordered segments (tools, then prompt parts), noting cache markers. */
function segments(options: LanguageModelV4CallOptions): Segment[] {
  const out: Segment[] = [{ text: JSON.stringify(options.tools ?? []), marked: false }];
  for (const message of options.prompt) {
    if (message.role === 'system') {
      out.push({ text: message.content, marked: hasMarker(message.providerOptions) });
      continue;
    }
    for (const part of message.content) {
      const text =
        part.type === 'text' ? part.text : part.type === 'file' ? 'x'.repeat(FILE_TOKENS * 4) : JSON.stringify(part);
      out.push({ text: `${message.role}:${text}`, marked: hasMarker(part.providerOptions) });
    }
    const last = out.at(-1);
    if (hasMarker(message.providerOptions) && last) last.marked = true;
  }
  return out;
}

/** Bound on remembered prefixes; the simulator forgets everything past it (dev only). */
const MAX_REMEMBERED_PREFIXES = 10_000;

export class PrefixCacheSimulator {
  private readonly seen = new Set<string>();

  usage(options: LanguageModelV4CallOptions, outputText: string): LanguageModelV4Usage {
    const segs = segments(options);
    const hash = createHash('sha256');
    let tokens = 0;
    const markers: Array<{ key: string; tokens: number }> = [];
    for (const seg of segs) {
      hash.update(seg.text);
      tokens += estimateTokens(seg.text);
      if (seg.marked) markers.push({ key: hash.copy().digest('hex'), tokens });
    }
    let read = 0;
    for (const m of markers) if (this.seen.has(m.key)) read = m.tokens;
    const lastMarker = markers.at(-1)?.tokens ?? 0;
    const write = Math.max(0, lastMarker - read);
    if (this.seen.size > MAX_REMEMBERED_PREFIXES) this.seen.clear();
    for (const m of markers) this.seen.add(m.key);
    const output = estimateTokens(outputText);
    return {
      inputTokens: { total: tokens, noCache: tokens - read - write, cacheRead: read, cacheWrite: write },
      outputTokens: { total: output, text: output, reasoning: 0 },
    };
  }
}
