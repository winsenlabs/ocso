import type { ModelCapabilities } from '../../contract/types.js';

/**
 * Capability heuristics per model family, keyed on model ids. They are
 * defaults: every provider accepts `settings.capabilityOverrides[model]`.
 */

export const isClaudeModel = (model: string) => /claude/i.test(model);

/** Claude models before 3.7 have no extended thinking. */
const CLAUDE_NO_REASONING = /claude-(instant|v2|2|3-haiku|3-sonnet|3-opus|3-5)/i;

export function claudeCapabilities(model: string): ModelCapabilities {
  return {
    imageInput: true,
    fileInput: true,
    audioInput: false,
    toolCalling: true,
    structuredOutput: true,
    reasoning: !CLAUDE_NO_REASONING.test(model),
    streaming: true,
    promptCaching: 'EXPLICIT',
    reportsCacheWrites: true,
  };
}

/** GPT-5.6+ and GPT-6+: explicit prompt-cache breakpoints, cache writes billed and reported. */
export const usesOpenAiCacheBreakpoints = (model: string) => /^gpt-(5\.([6-9]|\d{2,})|[6-9])/i.test(model);

const OPENAI_REASONING = /^(o\d|gpt-5|gpt-[6-9])/i;
const OPENAI_TEXT_ONLY = /^(gpt-3\.5|o1-mini|o3-mini)/i;

export function openAiCapabilities(model: string, explicitBreakpoints = usesOpenAiCacheBreakpoints(model)): ModelCapabilities {
  const multimodal = !OPENAI_TEXT_ONLY.test(model);
  return {
    imageInput: multimodal,
    fileInput: multimodal,
    audioInput: false,
    toolCalling: true,
    structuredOutput: true,
    reasoning: OPENAI_REASONING.test(model),
    streaming: true,
    promptCaching: 'AUTOMATIC',
    reportsCacheWrites: explicitBreakpoints,
  };
}

export function geminiCapabilities(model: string): ModelCapabilities {
  return {
    imageInput: true,
    fileInput: true,
    audioInput: true,
    toolCalling: true,
    structuredOutput: true,
    reasoning: /gemini-(2\.5|[3-9])/i.test(model),
    streaming: true,
    promptCaching: 'AUTOMATIC',
    // Gemini reports cachedContentTokenCount (reads) only.
    reportsCacheWrites: false,
  };
}

/** Conservative defaults for models we know nothing specific about. */
export function genericChatCapabilities(): ModelCapabilities {
  return {
    imageInput: false,
    fileInput: false,
    audioInput: false,
    toolCalling: true,
    structuredOutput: false,
    reasoning: false,
    streaming: true,
    promptCaching: 'UNVERIFIED',
    reportsCacheWrites: false,
  };
}
