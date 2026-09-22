import type { ToolResultOutput } from '@ocso/domain';

/**
 * ToolProvider contract (docs/02 §5). MCP connections implement it; built-in
 * OCSO tools implement it. Providers execute only after authorization passed.
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
}

export type ToolOutcome =
  | { status: 'SUCCEEDED'; output: ToolResultOutput; externalCorrelationId?: string | undefined; latencyMs: number }
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
