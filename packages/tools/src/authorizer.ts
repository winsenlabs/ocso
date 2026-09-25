import { Permission, can } from '@ocso/auth';
import { aiMaySendAutonomously } from '@ocso/domain';
import { evaluateArgumentRules } from './argument-rules.js';
import type {
  AuthorizationDecision,
  ConnectionRecord,
  DenialCode,
  SchemaValidator,
  ToolCallProposal,
  ToolRecord,
} from './types.js';

const deny = (code: DenialCode, reason: string): AuthorizationDecision => ({ outcome: 'DENY', code, reason });

const USABLE_CONNECTION_STATES = new Set(['ACTIVE', 'DEGRADED']);

function needsConfirmationByPolicy(tool: ToolRecord, connection: ConnectionRecord | null): boolean {
  const policy = connection?.confirmationPolicy ?? 'SENSITIVE_ONLY';
  if (policy === 'NONE') return false;
  if (policy === 'ALL_WRITES') return tool.riskClass !== 'READ';
  return tool.riskClass === 'SENSITIVE';
}

/**
 * Deterministic tool authorization (docs/archive/specs/08 §6). The model can never grant
 * itself anything: every input here comes from OCSO state, never from the
 * model except `args`, which is validated and policy-checked.
 */
export function authorizeToolCall(p: ToolCallProposal, validate: SchemaValidator): AuthorizationDecision {
  const { tool, connection, actor } = p;

  // 1. Tool exists and was approved by a Tech admin.
  if (!tool) return deny('tool_not_found', 'tool does not exist');
  if (!tool.approved || !tool.enabled) return deny('tool_not_approved', `${tool.displayName} is not approved`);

  // 2. Connection usable (built-in tools have no connection).
  if (tool.connectionId !== null) {
    if (!connection || connection.id !== tool.connectionId) return deny('connection_unusable', 'connection missing');
    if (!USABLE_CONNECTION_STATES.has(connection.status)) {
      return deny('connection_unusable', `connection ${connection.name} is ${connection.status.toLowerCase()}`);
    }
  }

  // 3. Agent allowed (connection allowlist + Lead grant); agents only act while AI owns the conversation.
  if (actor.kind === 'AGENT') {
    if (!aiMaySendAutonomously(actor.conversationState)) {
      return deny('conversation_state', `agent cannot act while conversation is ${actor.conversationState}`);
    }
    if (connection) {
      if (connection.scope === 'USER') return deny('agent_not_allowed', 'agents cannot use personal connections');
      if (connection.allowedAgentIds !== 'ALL' && !connection.allowedAgentIds.includes(actor.agentId)) {
        return deny('agent_not_allowed', 'connection not approved for this agent');
      }
    }
    if (!p.grant || !p.grant.enabled || p.grant.agentId !== actor.agentId) {
      return deny('agent_not_allowed', 'tool not enabled for this agent');
    }
  }

  // 4. Acting human principal allowed (workspace action or internal agent on their behalf).
  if (actor.kind === 'HUMAN' || actor.kind === 'INTERNAL_AGENT') {
    if (!can(actor.principal, Permission.TOOLS_EXECUTE_HUMAN)) {
      return deny('principal_not_allowed', 'role cannot execute tools');
    }
    if (!tool.humanRoles.includes(actor.principal.role)) {
      return deny('principal_not_allowed', `tool not available to ${actor.principal.role}`);
    }
    if (connection?.scope === 'USER' && connection.ownerUserId !== actor.principal.userId) {
      return deny('principal_not_allowed', 'personal connection belongs to another user');
    }
  }

  // 5. Requested scope granted on the connection.
  if (connection) {
    const missing = tool.requiredScopes.filter((s) => !connection.grantedScopes.includes(s));
    if (missing.length) return deny('scope_missing', `missing scope ${missing.join(', ')}`);
  }

  // 6. Argument schema.
  const validation = validate(tool.inputSchema, p.args);
  if (!validation.valid) return deny('invalid_arguments', validation.errors.slice(0, 5).join('; '));

  // 8 (before 7). Business policy rules on arguments; DENY wins over confirmation.
  const rules = evaluateArgumentRules(p.grant?.argumentRules ?? [], p.args);
  if (rules.deny) return deny('policy_denied', rules.deny.message);

  // 7. Confirmation requirement.
  const confirmationReason =
    rules.confirm?.message ??
    (p.grant?.alwaysConfirm ? 'agent policy requires confirmation' : null) ??
    (needsConfirmationByPolicy(tool, connection) ? `${tool.riskClass.toLowerCase()} action requires confirmation` : null);

  if (confirmationReason) {
    const confirmed = p.confirmation && p.confirmation.argsHash === p.argsHash;
    if (!confirmed) return { outcome: 'REQUIRE_CONFIRMATION', reason: confirmationReason };
    return { outcome: 'ALLOW', confirmedByUserId: p.confirmation!.approvedByUserId };
  }
  return { outcome: 'ALLOW', confirmedByUserId: null };
}
