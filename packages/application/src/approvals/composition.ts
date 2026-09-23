import { agentApproval, promptVersionApproval } from '../agents/approval.js';
import { ApprovalRegistry } from './registry.js';

/**
 * What descriptors may need from the process that builds the registry (the
 * API and the worker both call createApprovalRegistry). Wave-2 kinds add
 * optional fields here — e.g. the channel registry for a message template's
 * deferred provider submission — and receive them in their factory.
 */
export interface ApprovalRegistryDeps {
  readonly [dependency: string]: unknown;
}

/**
 * The one composition point for approvable kinds (PM/research/11 §4, like the
 * plugin registries of ADR-028): register every descriptor here, and the API,
 * the worker and the tests all see the same set. coverage.test.ts pins the list.
 */
export function createApprovalRegistry(_deps: ApprovalRegistryDeps = {}): ApprovalRegistry {
  return new ApprovalRegistry().register(agentApproval).register(promptVersionApproval);
}
