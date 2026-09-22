import { auditEvents, uuidv7, type DbOrTx } from '@ocso/db';
import { sanitizeForAudit } from '@ocso/tools';
import type { ActorContext } from '../shared/context.js';

export interface AuditEntry {
  action: string;
  targetType: string;
  targetId?: string | null | undefined;
  summary: string;
  before?: unknown;
  after?: unknown;
  confirmation?: Record<string, unknown> | undefined;
}

/**
 * Append an immutable audit event (docs/15 §7). Always call inside the same
 * transaction as the change being audited so neither can exist without the other.
 * Payloads pass through the same redaction as tool-call audit records.
 */
export async function recordAudit(tx: DbOrTx, actor: ActorContext, entry: AuditEntry): Promise<string> {
  const id = uuidv7();
  const principal = actor.principal;
  await tx.insert(auditEvents).values({
    id,
    actorType: principal ? 'USER' : actor.system?.kind === 'AGENT' ? 'AGENT' : 'SYSTEM',
    actorId: principal?.userId ?? actor.system?.id ?? null,
    actorName: principal?.displayName ?? actor.system?.name ?? null,
    via: principal?.via ?? 'SYSTEM',
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    summary: entry.summary,
    before: entry.before === undefined ? null : sanitizeForAudit(entry.before),
    after: entry.after === undefined ? null : sanitizeForAudit(entry.after),
    confirmation: entry.confirmation ?? null,
    correlationId: actor.correlationId,
    ip: actor.ip ?? null,
  });
  return id;
}
