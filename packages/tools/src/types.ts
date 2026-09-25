import type { Principal } from '@ocso/auth';
import type { ControlState } from '@ocso/domain';

/** Side-effect class (docs/archive/specs/08 §7). */
export type ToolRiskClass = 'READ' | 'WRITE' | 'SENSITIVE';

export type ConnectionStatus = 'PENDING' | 'AUTH_REQUIRED' | 'ACTIVE' | 'DEGRADED' | 'DOWN' | 'DISABLED';
export type ConnectionScope = 'SHARED' | 'USER';

/** How sensitive actions are gated for a connection (MCP approval step). */
export type ConfirmationPolicy = 'SENSITIVE_ONLY' | 'ALL_WRITES' | 'NONE';

export interface ToolRecord {
  id: string;
  connectionId: string | null; // null for built-in OCSO tools
  /** Model-facing, provider-safe name, e.g. `core_cards__list_transactions`. */
  modelName: string;
  displayName: string;
  riskClass: ToolRiskClass;
  approved: boolean;
  enabled: boolean;
  inputSchema: Record<string, unknown>;
  /** OAuth scopes this tool needs on its connection, if declared. */
  requiredScopes: readonly string[];
  /** Roles that may run this tool from the CS workspace. */
  humanRoles: readonly string[];
}

export interface ConnectionRecord {
  id: string;
  name: string;
  status: ConnectionStatus;
  scope: ConnectionScope;
  ownerUserId: string | null;
  /** Agents allowed to use this connection; `ALL` means any agent the Lead enables. */
  allowedAgentIds: readonly string[] | 'ALL';
  grantedScopes: readonly string[];
  confirmationPolicy: ConfirmationPolicy;
}

export type ArgumentOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'in' | 'not_in' | 'exists';

/** Deterministic business guard on tool arguments, e.g. "amount > 5000 ⇒ confirmation". */
export interface ArgumentRule {
  path: string;
  op: ArgumentOp;
  value?: unknown;
  effect: 'REQUIRE_CONFIRMATION' | 'DENY';
  message: string;
}

export interface AgentToolGrant {
  agentId: string;
  toolId: string;
  enabled: boolean;
  /** Force confirmation for this agent even when the connection policy would not. */
  alwaysConfirm: boolean;
  argumentRules: readonly ArgumentRule[];
}

export type ToolActor =
  | { kind: 'AGENT'; agentId: string; conversationState: ControlState }
  | { kind: 'HUMAN'; principal: Principal }
  | { kind: 'INTERNAL_AGENT'; principal: Principal };

export interface ToolCallProposal {
  tool: ToolRecord | null;
  connection: ConnectionRecord | null;
  grant: AgentToolGrant | null;
  actor: ToolActor;
  args: unknown;
  /** Set when a human already approved exactly these arguments. */
  confirmation: { approvedByUserId: string; argsHash: string } | null;
  argsHash: string;
}

export type AuthorizationDecision =
  | { outcome: 'ALLOW'; confirmedByUserId: string | null }
  | { outcome: 'REQUIRE_CONFIRMATION'; reason: string }
  | { outcome: 'DENY'; code: DenialCode; reason: string };

export type DenialCode =
  | 'tool_not_found'
  | 'tool_not_approved'
  | 'connection_unusable'
  | 'agent_not_allowed'
  | 'principal_not_allowed'
  | 'scope_missing'
  | 'invalid_arguments'
  | 'policy_denied'
  | 'conversation_state';

/** Validates arguments against the tool's JSON Schema; injected so this package stays pure. */
export type SchemaValidator = (schema: Record<string, unknown>, value: unknown) => { valid: true } | { valid: false; errors: string[] };
