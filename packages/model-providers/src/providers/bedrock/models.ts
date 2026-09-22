import type { ModelCapabilities } from '../../contract/types.js';
import { claudeCapabilities, genericChatCapabilities } from '../shared/model-families.js';

/**
 * Bedrock model-family heuristics on model / inference-profile ids
 * (`anthropic.claude-…`, `us.anthropic.claude-…`, `amazon.nova-…`, ARNs).
 */

export type BedrockFamily = 'claude' | 'nova' | 'other';

export function bedrockFamily(model: string): BedrockFamily {
  if (/anthropic\.claude/i.test(model)) return 'claude';
  if (/amazon\.nova/i.test(model)) return 'nova';
  return 'other';
}

/** `claude-<family>-<major>[-<minor>]` → [major, minor]; dated suffixes are not minors. */
function claudeVersion(model: string): [number, number] | null {
  const m = /claude-(?:opus|sonnet|haiku|fable)-(\d+)(?:-(\d)(?!\d))?/i.exec(model);
  if (!m?.[1]) return null;
  return [Number(m[1]), m[2] ? Number(m[2]) : 0];
}

/** The 1h cache TTL on Bedrock applies to Claude 4.5+ only (research/01 §4). */
export function bedrockSupportsLongCacheTtl(model: string): boolean {
  if (bedrockFamily(model) !== 'claude') return false;
  const v = claudeVersion(model);
  return v !== null && (v[0] > 4 || (v[0] === 4 && v[1] >= 5));
}

export function bedrockCapabilities(model: string): ModelCapabilities {
  const family = bedrockFamily(model);
  if (family === 'claude') return claudeCapabilities(model);
  if (family === 'nova') {
    return {
      imageInput: true,
      fileInput: true,
      audioInput: false,
      toolCalling: true,
      structuredOutput: true,
      reasoning: false,
      streaming: true,
      promptCaching: 'EXPLICIT',
      reportsCacheWrites: true,
    };
  }
  // Llama, Mistral, DeepSeek, gpt-oss…: no cachePoint support; never send markers.
  return { ...genericChatCapabilities(), promptCaching: 'UNSUPPORTED' };
}
