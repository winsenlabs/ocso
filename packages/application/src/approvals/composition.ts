import { agentApproval, promptVersionApproval } from '../agents/approval.js';
import { queueApproval } from '../routing/queue-approval.js';
import { routerApproval } from '../routing/router-approval.js';
import { slaPolicyApproval } from '../routing/sla-approval.js';
import { platformApprovals, type PlatformApprovalDeps } from '../settings/platform-registry.js';
import { businessApprovals, type BusinessApprovalDeps } from './business-kinds.js';
import { ApprovalRegistry } from './registry.js';

/**
 * What descriptors may need from the process that builds the registry (the
 * API and the worker both call createApprovalRegistry). Wave-2 kinds add
 * optional fields here — e.g. the channel registry for a message template's
 * deferred provider submission — and receive them in their factory.
 */
export interface ApprovalRegistryDeps {
  readonly [dependency: string]: unknown;
  /** COVERAGE-PLATFORM: secrets, channel/provider/delivery registries, MCP egress (settings/platform-registry.ts). */
  readonly platform?: PlatformApprovalDeps | undefined;
  /** COVERAGE-BUSINESS: template providers, the invite mailer, alert routing (approvals/business-kinds.ts). */
  readonly business?: BusinessApprovalDeps | undefined;
}

/**
 * The one composition point for approvable kinds (PM/research/11 §4, like the
 * plugin registries of ADR-028): register every descriptor here, and the API,
 * the worker and the tests all see the same set. coverage.test.ts pins the list.
 */
export function createApprovalRegistry(_deps: ApprovalRegistryDeps = {}): ApprovalRegistry {
  const registry = new ApprovalRegistry()
    .register(agentApproval)
    .register(promptVersionApproval)
    // ROUTING-WEB: routers, queues, SLA policies (approvals.check.routing).
    .register(routerApproval)
    .register(queueApproval)
    .register(slaPolicyApproval);
  // COVERAGE-PLATFORM: channels (approvals.check.channels) and platform objects (approvals.check.platform).
  for (const d of platformApprovals(_deps.platform)) registry.register(d);
  // COVERAGE-BUSINESS: tool grants, escalation and alert rules, message templates, users, permission changes.
  for (const d of businessApprovals(_deps.business)) registry.register(d);
  return registry;
}
