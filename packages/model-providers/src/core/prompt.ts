import {
  validation,
  type MediaResolver,
  type ModelContentPart,
  type ModelMessage,
  type SystemBlock,
  type ToolResultOutput,
} from '@ocso/domain';
import type {
  AssistantModelMessage,
  FilePart,
  JSONValue,
  ModelMessage as SdkModelMessage,
  SystemModelMessage,
  TextPart,
  ToolCallPart,
  ToolModelMessage,
  ToolResultPart,
  UserModelMessage,
} from 'ai';
import { breakpointSites, DEFAULT_MAX_BREAKPOINTS, selectBreakpoints, siteKey, type BreakpointSite } from './breakpoints.js';
import { resolveMedia, type ResolvedMedia } from './media.js';
import type { ProviderOptions, ProviderOptionsPlan } from './spec.js';

/**
 * Neutral OCSO prompt → AI SDK v7 prompt: one `SystemModelMessage` per
 * SystemBlock in `instructions`, messages mapped part by part, cache markers
 * placed on the system block / LAST part of the message that carries a
 * compiler breakpoint. Part level is honored by the Anthropic, Bedrock and
 * OpenAI paths (research/01 §4); the OpenAI Responses API has no breakpoint
 * slot on assistant output text, where its implicit tail breakpoint applies.
 */

export interface SdkPrompt {
  instructions: SystemModelMessage[];
  messages: SdkModelMessage[];
  /** Breakpoints actually marked (for tests and telemetry). */
  markedBreakpoints: BreakpointSite[];
}

type SdkPart = TextPart | FilePart | ToolCallPart | ToolResultPart;

function toolOutput(output: ToolResultOutput): ToolResultPart['output'] {
  if (output.type === 'text') return { type: 'text', value: output.value };
  if (output.type === 'error') return { type: 'error-text', value: output.value };
  // Tool results are sanitized JSON produced by OCSO's tool layer.
  return { type: 'json', value: output.value as JSONValue };
}

function convertPart(part: ModelContentPart, media: ReadonlyMap<string, ResolvedMedia>): SdkPart {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'image':
    case 'file': {
      const resolved = media.get(part.blobKey);
      if (!resolved) throw validation('media_missing', 'A media attachment could not be resolved');
      const file: FilePart = { type: 'file', data: resolved.data, mediaType: part.mimeType || resolved.mimeType };
      if (part.type === 'file' && part.filename) file.filename = part.filename;
      return file;
    }
    case 'tool-call':
      return { type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, input: part.input };
    case 'tool-result':
      return { type: 'tool-result', toolCallId: part.toolCallId, toolName: part.toolName, output: toolOutput(part.output) };
  }
}

const ALLOWED: Record<ModelMessage['role'], ReadonlySet<SdkPart['type']>> = {
  user: new Set(['text', 'file']),
  assistant: new Set(['text', 'file', 'tool-call']),
  tool: new Set(['tool-result']),
};

function convertMessage(
  message: ModelMessage,
  index: number,
  media: ReadonlyMap<string, ResolvedMedia>,
  marker: ProviderOptions | undefined,
): SdkModelMessage {
  if (message.content.length === 0) {
    throw validation('model_message_empty', `Message ${index} has no content`);
  }
  const parts = message.content.map((p) => convertPart(p, media));
  for (const p of parts) {
    if (!ALLOWED[message.role].has(p.type)) {
      throw validation('model_message_invalid_part', `A ${p.type} part is not allowed in a ${message.role} message`, {
        index,
      });
    }
  }
  const last = parts[parts.length - 1];
  if (marker && last) last.providerOptions = marker;
  if (message.role === 'user') return { role: 'user', content: parts as UserModelMessage['content'] } as UserModelMessage;
  if (message.role === 'assistant') {
    return { role: 'assistant', content: parts as AssistantModelMessage['content'] } as AssistantModelMessage;
  }
  return { role: 'tool', content: parts as ToolModelMessage['content'] } as ToolModelMessage;
}

export async function buildSdkPrompt(
  input: { system: readonly SystemBlock[]; messages: readonly ModelMessage[] },
  plan: Pick<ProviderOptionsPlan, 'breakpoint' | 'maxBreakpoints'>,
  resolver: MediaResolver,
): Promise<SdkPrompt> {
  const media = await resolveMedia(input.messages, resolver);
  const marker = plan.breakpoint;
  const marked = marker
    ? selectBreakpoints(breakpointSites(input.system, input.messages), plan.maxBreakpoints ?? DEFAULT_MAX_BREAKPOINTS)
    : [];
  const byKey = new Map(marked.map((s) => [siteKey(s.target, s.index), s]));
  const markerAt = (target: BreakpointSite['target'], index: number): ProviderOptions | undefined => {
    const site = byKey.get(siteKey(target, index));
    return site && marker ? marker(site.kind) : undefined;
  };

  const instructions = input.system.map((block, index): SystemModelMessage => {
    const m = markerAt('system', index);
    return m ? { role: 'system', content: block.text, providerOptions: m } : { role: 'system', content: block.text };
  });
  const messages = input.messages.map((message, index) => convertMessage(message, index, media, markerAt('message', index)));
  return { instructions, messages, markedBreakpoints: marked };
}
