import { describe, expect, it } from 'vitest';
import type { Principal } from '@ocso/auth';
import {
  authorizeToolCall,
  modelToolName,
  sanitizeForAudit,
  suggestRiskClass,
  type AgentToolGrant,
  type ConnectionRecord,
  type SchemaValidator,
  type ToolCallProposal,
  type ToolRecord,
} from '../src/index.js';

const validate: SchemaValidator = (schema, value) => {
  const required = (schema['required'] as string[] | undefined) ?? [];
  const missing = required.filter((k) => !(value && typeof value === 'object' && k in value));
  return missing.length ? { valid: false, errors: missing.map((k) => `missing ${k}`) } : { valid: true };
};

const tool = (over: Partial<ToolRecord> = {}): ToolRecord => ({
  id: 'tool-reverse',
  connectionId: 'conn-cards',
  modelName: 'core_cards__reverse_transaction',
  displayName: 'payments.reverse_transaction',
  riskClass: 'SENSITIVE',
  approved: true,
  enabled: true,
  inputSchema: { type: 'object', required: ['txnId', 'amount'] },
  requiredScopes: ['payments.write'],
  humanRoles: ['CS_EXEC', 'CS_LEAD'],
  ...over,
});

const connection = (over: Partial<ConnectionRecord> = {}): ConnectionRecord => ({
  id: 'conn-cards',
  name: 'core-cards',
  status: 'ACTIVE',
  scope: 'SHARED',
  ownerUserId: null,
  allowedAgentIds: ['agt-maya'],
  grantedScopes: ['payments.write', 'cards.read'],
  confirmationPolicy: 'SENSITIVE_ONLY',
  ...over,
});

const grant = (over: Partial<AgentToolGrant> = {}): AgentToolGrant => ({
  agentId: 'agt-maya',
  toolId: 'tool-reverse',
  enabled: true,
  alwaysConfirm: false,
  argumentRules: [],
  ...over,
});

const exec: Principal = { userId: 'u-nikhil', role: 'CS_EXEC', displayName: 'Nikhil', teamIds: [], via: 'UI' };
const args = { txnId: 'TXN-8841-2290', amount: 12480 };

const proposal = (over: Partial<ToolCallProposal> = {}): ToolCallProposal => ({
  tool: tool(),
  connection: connection(),
  grant: grant(),
  actor: { kind: 'AGENT', agentId: 'agt-maya', conversationState: 'AI_ACTIVE' },
  args,
  argsHash: 'h1',
  confirmation: null,
  ...over,
});

describe('tool authorization (docs/08 §6)', () => {
  it('denies unknown and unapproved tools', () => {
    expect(authorizeToolCall(proposal({ tool: null }), validate)).toMatchObject({ outcome: 'DENY', code: 'tool_not_found' });
    expect(authorizeToolCall(proposal({ tool: tool({ approved: false }) }), validate)).toMatchObject({
      code: 'tool_not_approved',
    });
  });

  it('denies when the connection is down, disabled or awaiting auth', () => {
    for (const status of ['DOWN', 'DISABLED', 'AUTH_REQUIRED', 'PENDING'] as const) {
      expect(authorizeToolCall(proposal({ connection: connection({ status }) }), validate)).toMatchObject({
        code: 'connection_unusable',
      });
    }
    expect(authorizeToolCall(proposal({ connection: connection({ status: 'DEGRADED' }) }), validate).outcome).not.toBe(
      'DENY',
    );
  });

  it('denies agents not on the connection allowlist or without a grant', () => {
    expect(authorizeToolCall(proposal({ connection: connection({ allowedAgentIds: ['agt-arjun'] }) }), validate)).toMatchObject({
      code: 'agent_not_allowed',
    });
    expect(authorizeToolCall(proposal({ grant: grant({ enabled: false }) }), validate)).toMatchObject({ code: 'agent_not_allowed' });
    expect(authorizeToolCall(proposal({ grant: null }), validate)).toMatchObject({ code: 'agent_not_allowed' });
  });

  it('denies agents using personal (user-scoped) connections', () => {
    expect(authorizeToolCall(proposal({ connection: connection({ scope: 'USER', ownerUserId: 'u1' }) }), validate)).toMatchObject({
      code: 'agent_not_allowed',
    });
  });

  it('denies agent tool calls while a human owns the conversation', () => {
    expect(
      authorizeToolCall(proposal({ actor: { kind: 'AGENT', agentId: 'agt-maya', conversationState: 'HUMAN_ACTIVE' } }), validate),
    ).toMatchObject({ code: 'conversation_state' });
  });

  it('denies missing OAuth scopes and invalid arguments', () => {
    expect(authorizeToolCall(proposal({ connection: connection({ grantedScopes: ['cards.read'] }) }), validate)).toMatchObject({
      code: 'scope_missing',
    });
    expect(authorizeToolCall(proposal({ args: { txnId: 'x' } }), validate)).toMatchObject({ code: 'invalid_arguments' });
  });

  it('requires confirmation for sensitive tools and allows once the exact args were confirmed', () => {
    expect(authorizeToolCall(proposal(), validate).outcome).toBe('REQUIRE_CONFIRMATION');
    const confirmed = authorizeToolCall(proposal({ confirmation: { approvedByUserId: 'u-nikhil', argsHash: 'h1' } }), validate);
    expect(confirmed).toEqual({ outcome: 'ALLOW', confirmedByUserId: 'u-nikhil' });
    // A confirmation for different arguments does not carry over.
    expect(authorizeToolCall(proposal({ confirmation: { approvedByUserId: 'u', argsHash: 'other' } }), validate).outcome).toBe(
      'REQUIRE_CONFIRMATION',
    );
  });

  it('applies argument rules: DENY beats confirmation; thresholds trigger confirmation', () => {
    const readTool = tool({ riskClass: 'READ' });
    const thresholds = grant({
      argumentRules: [{ path: 'amount', op: 'gt', value: 5000, effect: 'REQUIRE_CONFIRMATION', message: 'above ₹5,000 authority' }],
    });
    expect(authorizeToolCall(proposal({ tool: readTool, grant: thresholds }), validate)).toEqual({
      outcome: 'REQUIRE_CONFIRMATION',
      reason: 'above ₹5,000 authority',
    });
    expect(authorizeToolCall(proposal({ tool: readTool, grant: thresholds, args: { txnId: 't', amount: 100 } }), validate)).toEqual({
      outcome: 'ALLOW',
      confirmedByUserId: null,
    });
    const blocked = grant({ argumentRules: [{ path: 'amount', op: 'gt', value: 100000, effect: 'DENY', message: 'never above ₹1L' }] });
    expect(authorizeToolCall(proposal({ grant: blocked, args: { txnId: 't', amount: 200000 } }), validate)).toMatchObject({
      outcome: 'DENY',
      code: 'policy_denied',
    });
  });

  it('checks human role and personal connection ownership', () => {
    const human = { kind: 'HUMAN' as const, principal: exec };
    expect(authorizeToolCall(proposal({ actor: human, tool: tool({ riskClass: 'READ' }) }), validate).outcome).toBe('ALLOW');
    expect(authorizeToolCall(proposal({ actor: human, tool: tool({ humanRoles: ['CS_LEAD'] }) }), validate)).toMatchObject({
      code: 'principal_not_allowed',
    });
    const admin = { kind: 'HUMAN' as const, principal: { ...exec, role: 'PLATFORM_TECH_ADMIN' as const } };
    expect(authorizeToolCall(proposal({ actor: admin }), validate)).toMatchObject({ code: 'principal_not_allowed' });
    expect(
      authorizeToolCall(
        proposal({ actor: human, tool: tool({ riskClass: 'READ' }), connection: connection({ scope: 'USER', ownerUserId: 'someone-else' }) }),
        validate,
      ),
    ).toMatchObject({ code: 'principal_not_allowed' });
  });

  it('ignores anything the model puts in arguments when deciding permissions', () => {
    const sneaky = { ...args, approved: true, confirmation: 'granted', role: 'PLATFORM_TECH_ADMIN' };
    expect(authorizeToolCall(proposal({ args: sneaky }), validate).outcome).toBe('REQUIRE_CONFIRMATION');
  });
});

describe('tool classification and sanitization', () => {
  it('suggests risk conservatively from MCP annotations', () => {
    expect(suggestRiskClass({ readOnlyHint: true })).toBe('READ');
    expect(suggestRiskClass({ readOnlyHint: false, destructiveHint: false })).toBe('WRITE');
    expect(suggestRiskClass({ destructiveHint: true })).toBe('SENSITIVE');
    expect(suggestRiskClass(undefined)).toBe('SENSITIVE');
  });

  it('builds provider-safe model tool names', () => {
    expect(modelToolName('core-cards', 'payments.reverse_transaction')).toBe('core-cards__payments_reverse_transaction');
    expect(modelToolName('x'.repeat(80), 'y').length).toBeLessThanOrEqual(64);
  });

  it('redacts secrets and masks card numbers in audit payloads', () => {
    const out = sanitizeForAudit({ apiKey: 'sk-live', nested: { password: 'p' }, card: '4111 1111 1111 4417', amount: 5 }) as Record<
      string,
      unknown
    >;
    expect(out['apiKey']).toBe('[REDACTED]');
    expect((out['nested'] as Record<string, unknown>)['password']).toBe('[REDACTED]');
    expect(out['card']).toBe('••••4417');
    expect(out['amount']).toBe(5);
  });
});
