import type { ModelMessage, SystemBlock, ToolSpec } from '@ocso/domain';
import { BUSINESS_COMPONENT_KEYS, COMPONENT_DESCRIPTORS, type PromptComponents } from './components.js';
import { canonicalJson, contentHash } from './hash.js';
import {
  renderConversationFrame,
  renderCustomerContext,
  renderHandover,
  renderSummary,
  wrap,
} from './render-context.js';
import { renderHistory } from './render-history.js';
import { RUNTIME_CONTRACT_TEXT, RUNTIME_CONTRACT_VERSION } from './runtime-contract.js';
import { estimateTokens } from './tokens.js';
import type { CompiledPrompt, CompileInput } from './types.js';

const DEFAULT_MEDIA_WINDOW = 6;

/** Identity hash of a prompt version: platform contract + business components. */
export function promptVersionHash(components: PromptComponents): string {
  return contentHash({ contract: RUNTIME_CONTRACT_VERSION, components }, 'pc');
}

export function toolSchemaHash(tools: readonly ToolSpec[]): string {
  return contentHash(sortTools(tools), 'ts');
}

export function sortTools(tools: readonly ToolSpec[]): ToolSpec[] {
  return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function stableBlocks(components: PromptComponents): SystemBlock[] {
  const blocks: SystemBlock[] = [
    { key: 'runtime_contract', text: wrap('ocso_runtime_contract', RUNTIME_CONTRACT_TEXT), stable: true },
  ];
  for (const key of BUSINESS_COMPONENT_KEYS) {
    const text = components[key]?.trim();
    if (!text) continue;
    const tag = COMPONENT_DESCRIPTORS.find((d) => d.key === key)?.tag ?? key;
    blocks.push({ key, text: wrap(tag, text), stable: true });
  }
  blocks[blocks.length - 1]!.breakpointAfter = 'AGENT_PREFIX';
  return blocks;
}

function conversationBlocks(input: CompileInput): SystemBlock[] {
  const rendered: Array<[string, string | null]> = [
    ['conversation', renderConversationFrame(input)],
    ['customer_context', renderCustomerContext(input)],
    ['conversation_summary', renderSummary(input)],
    ['handover', renderHandover(input)],
  ];
  const blocks = rendered
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([key, text]): SystemBlock => ({ key, text, stable: false }));
  blocks[blocks.length - 1]!.breakpointAfter = 'CONVERSATION_CONTEXT';
  return blocks;
}

/**
 * Recent (already answered) history is cacheable; the current customer
 * messages are not. The HISTORY breakpoint sits on the last message that is
 * entirely recent history.
 */
function messagesFor(input: CompileInput): ModelMessage[] {
  const window = input.mediaWindow ?? DEFAULT_MEDIA_WINDOW;
  const recent = renderHistory(input.recent, input.capabilities, window);
  const current = renderHistory(input.current, input.capabilities, window);
  const firstCurrent = current[0];
  const lastRecent = recent.at(-1);
  if (lastRecent && firstCurrent && lastRecent.role === firstCurrent.role) {
    lastRecent.content.push(...firstCurrent.content);
    current.shift();
    const boundary = recent.at(-2);
    if (boundary) boundary.breakpointAfter = 'HISTORY';
  } else if (lastRecent) {
    lastRecent.breakpointAfter = 'HISTORY';
  }
  return [...recent, ...current];
}

export function compilePrompt(input: CompileInput): CompiledPrompt {
  const tools = sortTools(input.tools);
  const stable = stableBlocks(input.promptVersion.components);
  const conversation = conversationBlocks(input);
  const messages = messagesFor(input);

  const componentHashes: Record<string, string> = { runtime_contract: contentHash(RUNTIME_CONTRACT_TEXT, 'c') };
  for (const key of BUSINESS_COMPONENT_KEYS) {
    componentHashes[key] = contentHash(input.promptVersion.components[key] ?? '', 'c');
  }
  const tsHash = toolSchemaHash(tools);
  const agentPrefixHash = contentHash({ tools: tsHash, system: stable.map((b) => b.text) }, 'ap');
  const customerContextHash = input.customer ? contentHash(input.customer, 'cc') : null;
  const conversationContextHash = contentHash(conversation.map((b) => b.text), 'cx');

  const stableTokens = estimateTokens(stable.map((b) => b.text).join('\n')) + estimateTokens(canonicalJson(tools));
  const conversationTokens = estimateTokens(conversation.map((b) => b.text).join('\n'));
  const messageTokens = estimateTokens(canonicalJson(messages));

  return {
    system: [...stable, ...conversation],
    messages,
    tools,
    hashes: {
      runtimeContractVersion: RUNTIME_CONTRACT_VERSION,
      promptVersionHash: promptVersionHash(input.promptVersion.components),
      components: componentHashes,
      toolSchemaHash: tsHash,
      agentPrefixHash,
      conversationContextHash,
      customerContextHash,
      fullHash: contentHash({ agentPrefixHash, conversationContextHash, messages }, 'fp'),
    },
    tokenEstimate: {
      stable: stableTokens,
      conversation: conversationTokens,
      messages: messageTokens,
      total: stableTokens + conversationTokens + messageTokens,
    },
  };
}
