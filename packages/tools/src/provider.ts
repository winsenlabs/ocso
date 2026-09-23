import type { Priority, ToolResultOutput } from '@ocso/domain';

/**
 * ToolProvider contract (docs/02 §5). MCP connections implement it; built-in
 * OCSO tools implement it. Providers execute only after the runtime has
 * authorized the call (authorizeToolCall) and written its tool_calls row —
 * a provider never authorizes or audits by itself.
 */
export interface ToolInvocation {
  toolCallId: string;
  /** The tool's name on its own server (not the model-facing name). */
  toolName: string;
  args: unknown;
  timeoutMs: number;
  /** Short-lived signed customer claims for trusted connections (docs/08 §4). */
  customerClaims?: string | undefined;
  idempotencyKey?: string | undefined;
  signal?: AbortSignal | undefined;
  /**
   * The conversation the call runs in. Given to first-party providers only
   * (they read OCSO state for it); external providers never receive it.
   */
  scope?: ToolCallScope | undefined;
}

export interface ToolCallScope {
  conversationId: string;
  customerId: string;
  agentId: string;
  /** First seq of the model's recent-history window; older messages are retrievable history. */
  historyWindowStartSeq: number;
}

/** A human handoff the agent asked for; the runtime performs it when the turn ends. */
export interface HandoffRequest {
  reason: string;
  summary: string;
  priority?: Priority | undefined;
  customerAskedForHuman?: boolean | undefined;
}

/**
 * A conversation-control effect a first-party tool asks the runtime to apply.
 * The runtime honours effects from first-party providers only, so an external
 * server can never change who owns a conversation.
 */
export type ToolEffect = { type: 'handoff'; request: HandoffRequest } | { type: 'transfer'; request: QueueTransferRequest };

/** A move to another queue and its AI agent (PM/research/11 §5.5); the runtime performs it when the turn ends. */
export interface QueueTransferRequest {
  queueId: string;
  reason: string;
  summary: string;
}

export type ToolOutcome =
  | {
      status: 'SUCCEEDED';
      output: ToolResultOutput;
      externalCorrelationId?: string | undefined;
      latencyMs: number;
      effect?: ToolEffect | undefined;
    }
  | {
      status: 'FAILED';
      errorCategory: 'tool_unavailable' | 'tool_rejected' | 'timeout' | 'validation' | 'internal';
      /** Safe message for the model; never raw exception text. */
      message: string;
      latencyMs: number;
    };

export interface ToolProvider {
  readonly connectionId: string | null;
  invoke(call: ToolInvocation): Promise<ToolOutcome>;
}
