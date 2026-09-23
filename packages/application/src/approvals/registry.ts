import { APPROVAL_CHECK_PERMISSIONS, type Permission } from '@ocso/auth';
import { notFound } from '@ocso/domain';
import type { ApprovalDescriptor } from './contract.js';

/** Kinds that are runtime work, never configuration: claiming, replying and resolving are never approved. */
export const RUNTIME_KINDS: ReadonlySet<string> = new Set(['conversation', 'handoff', 'interaction', 'assignment', 'tool_call']);

/** Every approvable kind, keyed by descriptor kind. Areas register their descriptors at composition. */
export class ApprovalRegistry {
  private readonly byKind = new Map<string, ApprovalDescriptor>();

  register(descriptor: ApprovalDescriptor): this {
    if (this.byKind.has(descriptor.kind)) throw new Error(`approval kind ${descriptor.kind} already registered`);
    if (RUNTIME_KINDS.has(descriptor.kind)) throw new Error(`${descriptor.kind} is runtime work and is never approved`);
    if (!(APPROVAL_CHECK_PERMISSIONS as readonly Permission[]).includes(descriptor.checkPermission)) {
      throw new Error(`approval kind ${descriptor.kind} must be checked with an approvals.check.* permission`);
    }
    this.byKind.set(descriptor.kind, descriptor);
    return this;
  }

  get(kind: string): ApprovalDescriptor {
    const descriptor = this.byKind.get(kind);
    if (!descriptor) throw notFound('approval_kind', kind);
    return descriptor;
  }

  has(kind: string): boolean {
    return this.byKind.has(kind);
  }

  kinds(): readonly string[] {
    return [...this.byKind.keys()];
  }

  all(): readonly ApprovalDescriptor[] {
    return [...this.byKind.values()];
  }

  /** Every permission that lets someone propose a change of some registered kind. */
  makePermissions(): readonly Permission[] {
    return [...new Set(this.all().flatMap((d) => d.actions.map((a) => d.makePermission(a))))];
  }
}
