import type { Db } from '@ocso/db';
import { recordAudit, type AuditEntry } from '../../audit/audit.js';
import type { ActorContext } from '../../shared/context.js';
import { loadPrincipal } from '../sessions.js';
import { clientIpOf, correlationIdOf } from './request.js';

/** Request facts an auth hook has: headers (for IP and correlation id). */
export interface HookRequest {
  request?: Request | undefined;
  headers?: Headers | undefined;
}

export type AuthLog = (level: 'debug' | 'info' | 'warn' | 'error', message: string, err?: unknown) => void;

/**
 * Audit trail for authentication events (docs/15 §7). Never records
 * passwords, codes, tokens or secrets — only who, what and from where.
 */
export class AuthAudit {
  constructor(
    private readonly db: Db,
    private readonly log: AuthLog,
  ) {}

  /** Actor = the user the event is about (a principal, even while disabled for failed attempts). */
  async asUser(userId: string, req: HookRequest, entry: Omit<AuditEntry, 'targetType' | 'targetId'> & { sessionId?: string | undefined }): Promise<void> {
    const principal = await loadPrincipal(this.db, userId, 'UI', entry.sessionId);
    const actor: ActorContext = principal
      ? { principal, correlationId: correlationIdOf(req), ip: clientIpOf(req) }
      : { principal: null, system: { kind: 'SYSTEM', id: 'auth', name: 'Authentication' }, correlationId: correlationIdOf(req), ip: clientIpOf(req) };
    await this.write(actor, { action: entry.action, summary: entry.summary, targetType: 'user', targetId: userId, after: entry.after });
  }

  /** Events without a known user (e.g. a failed sign-in for an unknown email). */
  async asSystem(req: HookRequest, entry: AuditEntry): Promise<void> {
    await this.write({ principal: null, system: { kind: 'SYSTEM', id: 'auth', name: 'Authentication' }, correlationId: correlationIdOf(req), ip: clientIpOf(req) }, entry);
  }

  private async write(actor: ActorContext, entry: AuditEntry): Promise<void> {
    try {
      await recordAudit(this.db, actor, entry);
    } catch (err) {
      // Auditing must not turn a completed sign-in into an error; the failure is logged loudly instead.
      this.log('error', `audit write failed for ${entry.action}`, err);
    }
  }
}
