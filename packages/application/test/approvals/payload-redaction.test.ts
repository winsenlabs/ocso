import { describe, expect, it } from 'vitest';
import { sanitizeForAudit } from '@ocso/tools';
import { createApprovalRegistry } from '../../src/approvals/index.js';

/**
 * A proposal's payload is replayed on activation, so it is stored raw and
 * never returned over HTTP. The compensating rule: it never carries a secret
 * value (only a secretRef). If redaction would change a descriptor's sample
 * payload, that payload carries a secret — fix the descriptor.
 */
const SAMPLES: Record<string, Record<string, unknown>> = {
  agent: {
    name: 'Maya',
    purpose: 'Cards and EMI support',
    modelProfileId: '01a0cd12-87fc-71e6-85ff-7b598bcdf97b',
    maxToolSteps: 4,
    businessHours: { timezone: 'Asia/Kolkata', humanHours: { mon: ['09:00', '18:00'] } },
    channelIds: ['01a0cd12-87fc-71e6-85ff-7b598bcdf97c'],
    multimodal: { imageInput: true, documentInput: true, audioInput: false, maxMediaPerTurn: 4 },
  },
  prompt_version: {},
  router: { name: 'Language menu', description: 'English / Tamil', attachChannelIds: ['01a0cd12-87fc-71e6-85ff-7b598bcdf97c'] },
  queue: {
    agentId: '01a0cd12-87fc-71e6-85ff-7b598bcdf97b',
    attributes: { language: 'ta' },
    businessHours: { timezone: 'Asia/Kolkata', humanHours: { mon: ['09:00', '18:00'] } },
    addTeamIds: ['01a0cd12-87fc-71e6-85ff-7b598bcdf97d'],
    addTransferTargetIds: ['01a0cd12-87fc-71e6-85ff-7b598bcdf97e'],
    acceptTimeoutSeconds: 90,
  },
  sla_policy: { name: 'Standard', firstHumanResponseSeconds: 900, pickupSecondsByPriority: { P1: 300 }, resolutionSecondsByType: { SUPPORT: 86_400 }, atRiskFraction: 0.75 },
  // COVERAGE-BUSINESS
  agent_tool_grant: {
    grants: [
      {
        toolId: '01a0cd12-87fc-71e6-85ff-7b598bcdf97b',
        enabled: true,
        alwaysConfirm: false,
        argumentRules: [{ path: 'amountMinor', op: 'gt', value: 500000, effect: 'REQUIRE_CONFIRMATION', message: 'Large reversal' }],
      },
    ],
  },
  escalation_rule: { name: 'Fraud words', trigger: 'POLICY', condition: { keywords: ['fraud', 'chargeback'] }, targetQueueId: '01a0cd12-87fc-71e6-85ff-7b598bcdf97c', priority: 'P1' },
  alert_rule: { name: 'CSAT floor', params: { threshold: 3.5 }, severity: 'CRITICAL', audienceRoles: ['HEAD', 'LEAD'], windowSeconds: 3600 },
  alert_rule_technical: { name: 'Workers', params: {}, severity: 'CRITICAL', audienceRoles: ['TECH'], dedupeWindowSeconds: 600 },
  message_template: {},
  user: {
    userId: '01a0cd12-87fc-71e6-85ff-7b598bcdf97b',
    makerId: '01a0cd12-87fc-71e6-85ff-7b598bcdf97c',
    rights: { role: 'LEAD', teamIds: ['01a0cd12-87fc-71e6-85ff-7b598bcdf97d'], overrides: [] },
  },
  permission_change: {
    userId: '01a0cd12-87fc-71e6-85ff-7b598bcdf97b',
    makerId: '01a0cd12-87fc-71e6-85ff-7b598bcdf97c',
    role: 'HEAD',
    teams: { add: ['01a0cd12-87fc-71e6-85ff-7b598bcdf97d'], remove: [] },
    ops: [{ op: 'GRANT', permission: 'agents.delete', expiresAt: '2026-12-31T00:00:00.000Z' }],
    reason: 'Covering for the Head of Cards',
  },
  // COVERAGE-PLATFORM: new secret values travel as refs created at submit, never as values.
  channel: { name: 'WhatsApp — Twilio', settings: { accountSid: 'AC123', fromNumber: '+14155550100' }, credentials: [{ field: 'authToken', ref: 'sec_twilio_4f81a2' }] },
  model_provider: { name: 'OpenAI', region: 'us', settings: { baseUrl: 'https://api.openai.com/v1' }, maxConcurrency: 40, credentials: [{ field: 'apiKey', ref: 'sec_openai_91bc02' }], removeCredentials: ['organization'] },
  model_profile: { model: 'gpt-5.5', temperature: 0.2, maxOutputTokens: 2048, fallbacks: [{ providerId: '01a0cd12-87fc-71e6-85ff-7b598bcdf97b', model: 'gpt-5.5-mini' }] },
  model_pricing: { inputPerMTokMicros: 1_250_000, outputPerMTokMicros: 10_000_000, effectiveFrom: '2026-10-01T00:00:00.000Z' },
  mcp_connection: {
    policy: { allowedAgentIds: ['01a0cd12-87fc-71e6-85ff-7b598bcdf97b'], confirmationPolicy: 'ALL_WRITES', sendCustomerClaims: false, forwardUserToken: false, healthCheckSeconds: 60 },
    tools: [{ toolId: '01a0cd12-87fc-71e6-85ff-7b598bcdf97c', riskClass: 'WRITE', approved: true, humanRoles: ['HEAD'] }],
    headerCredential: { headerName: 'X-Api-Key', ref: 'sec_mcp_7d21aa' },
  },
  notification_destination: { name: 'Ops Slack', config: { channel: '#alerts-ops' }, credentialRef: 'sec_slack_0a11ce' },
  webhook_subscription: { name: 'CRM sync', url: 'https://crm.example.com/hooks/ocso', events: ['conversation.resolved'] },
  sso_provider: { name: 'Bank Okta', domains: ['bank.example'], autoProvision: false },
  deployment_settings: {
    deployment: { timezone: 'Asia/Kolkata', residencyZone: 'IN', egressAllowedInternalHosts: ['core.bank.internal'] },
    visibility: { execsCanViewAiActive: false },
    retention: { conversationContent: 180, auditEvents: 2555 },
    workers: { minWarmWorkers: 2, maxWorkers: 8 },
    mfa: { requireMfaRoles: ['TECH', 'HEAD'] },
    approvals: { approvalAgeWarningHours: 48 },
    audit: { auditLocalWindowDays: 120 },
  },
};

/**
 * Configuration keys the redactor's name heuristic masks although they never hold a secret (ADR-030
 * deviation 1): a model profile's `maxOutputTokens` is a number. Compared with the key removed, so any other
 * masked key still fails.
 */
const NOT_SECRETS = new Set(['maxOutputTokens', 'forwardUserToken']); // forwardUserToken: an MCP connection's boolean policy flag
const withoutNonSecrets = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(o)
      .filter(([k]) => !NOT_SECRETS.has(k))
      .map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) ? withoutNonSecrets(v as Record<string, unknown>) : v]),
  );

describe('approval payloads carry no secrets', () => {
  const registry = createApprovalRegistry();

  it('has a sample for every kind', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...registry.kinds()].sort());
  });

  it.each(Object.entries(SAMPLES))('%s: the parsed sample survives redaction unchanged', (kind, sample) => {
    const d = registry.get(kind);
    const parsed = d.payload ? (d.payload.parse(sample) as Record<string, unknown>) : sample;
    expect(sanitizeForAudit(withoutNonSecrets(parsed))).toEqual(withoutNonSecrets(parsed));
  });
});
