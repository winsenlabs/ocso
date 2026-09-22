/**
 * Provider-neutral model request vocabulary shared by the prompt compiler,
 * agent runtime and provider adapters. No provider/SDK types appear here
 * (build rule §12); adapters translate these at their boundary.
 */

/** Where a prompt cache breakpoint sits. Adapters map these to native controls. */
export type CacheBreakpoint = 'AGENT_PREFIX' | 'CONVERSATION_CONTEXT' | 'HISTORY';

export interface SystemBlock {
  /** Component key, e.g. `runtime_contract`, `identity`, `customer_context`. */
  key: string;
  text: string;
  /** Stable blocks are identical across conversations of the same agent version. */
  stable: boolean;
  /** Cache breakpoint placed immediately after this block, if any. */
  breakpointAfter?: CacheBreakpoint | undefined;
}

export type ModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; blobKey: string; mimeType: string }
  | { type: 'file'; blobKey: string; mimeType: string; filename?: string | undefined }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | {
      type: 'tool-result';
      toolCallId: string;
      toolName: string;
      output: ToolResultOutput;
    };

export type ToolResultOutput =
  | { type: 'json'; value: unknown }
  | { type: 'text'; value: string }
  | { type: 'error'; value: string };

export interface ModelMessage {
  role: 'user' | 'assistant' | 'tool';
  content: ModelContentPart[];
  /** Cache breakpoint placed at the end of this message, if any. */
  breakpointAfter?: CacheBreakpoint | undefined;
}

/** A tool as presented to the model: schema only, never an executor (ADR-014). */
export interface ToolSpec {
  /** Model-facing name (provider-safe charset), e.g. `core_cards__list_transactions`. */
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12 subset) for the input object. */
  inputSchema: Record<string, unknown>;
}

/** Resolves blob references to bytes inside trusted adapter code. */
export interface MediaResolver {
  resolve(blobKey: string): Promise<{ data: Uint8Array; mimeType: string }>;
}
