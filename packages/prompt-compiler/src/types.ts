import type {
  ConversationType,
  InteractionPart,
  ModelMessage,
  SystemBlock,
  ToolSpec,
} from '@ocso/domain';
import type { PromptComponents } from './components.js';

export interface HistoryEntry {
  seq: number;
  actorType: 'CUSTOMER' | 'AGENT' | 'HUMAN' | 'SYSTEM';
  /** Display name for HUMAN entries ("Nikhil Menon"). */
  actorName?: string | undefined;
  parts: readonly InteractionPart[];
}

export interface CustomerContext {
  customerId: string;
  displayName?: string | undefined;
  language?: string | undefined;
  /** Stable, non-secret attributes (segment, CIF, preferences). */
  attributes: Readonly<Record<string, unknown>>;
}

export interface SummaryContext {
  version: number;
  coversThroughSeq: number;
  text: string;
}

export interface HandoverContext {
  summary: string;
  notes: readonly string[];
  humanName?: string | undefined;
}

export interface ModelInputCapabilities {
  imageInput: boolean;
  fileInput: boolean;
  audioInput: boolean;
}

/**
 * The channel's limits as its adapter declares them (ChannelCapabilities);
 * the compiler turns them into the channel block, so no business prompt has
 * to restate a channel's length, formatting or media rules.
 */
export interface ChannelLimits {
  maxTextLength: number;
  /** Plain text, basic emphasis and lists, or full CommonMark. */
  markdown: 'none' | 'basic' | 'commonmark';
  /** Part types the channel delivers to the customer (IMAGE, AUDIO, VIDEO, DOCUMENT, …). */
  outboundParts: readonly string[];
}

export interface ChannelContext {
  kind: string;
  /** The channel's configured name. */
  label: string;
  limits?: ChannelLimits | undefined;
}

export interface CompileInput {
  agent: { id: string; name: string; conversationType: ConversationType };
  promptVersion: { id: string; version: number; components: PromptComponents };
  tools: readonly ToolSpec[];
  /** Null for conversations without a channel (previews, replays of channel-less conversations). */
  channel: ChannelContext | null;
  customer: CustomerContext | null;
  summary: SummaryContext | null;
  handover: HandoverContext | null;
  /** Interactions already answered, oldest first (after the summary window). */
  recent: readonly HistoryEntry[];
  /** Customer interactions this turn responds to, oldest first. */
  current: readonly HistoryEntry[];
  capabilities: ModelInputCapabilities;
  /** Include media parts only for the newest N history entries. */
  mediaWindow?: number | undefined;
  /** Calendar date (YYYY-MM-DD) in the deployment timezone. */
  today: string;
}

export interface CompiledPromptHashes {
  runtimeContractVersion: string;
  /** Hash of runtime contract version + business components (prompt version identity). */
  promptVersionHash: string;
  components: Readonly<Record<string, string>>;
  toolSchemaHash: string;
  /** Everything before the AGENT_PREFIX breakpoint (tools + stable system). */
  agentPrefixHash: string;
  /** Conversation frame + channel + customer context + summary + handover. */
  conversationContextHash: string;
  customerContextHash: string | null;
  /** Hash of the full request (for audit and debugging). */
  fullHash: string;
}

export interface CompiledPrompt {
  system: SystemBlock[];
  messages: ModelMessage[];
  tools: ToolSpec[];
  hashes: CompiledPromptHashes;
  tokenEstimate: { stable: number; conversation: number; messages: number; total: number };
}
