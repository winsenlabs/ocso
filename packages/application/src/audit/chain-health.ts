import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { trustedKeys, verifyChain, type AuditSigner, type AuditStore, type ChainProblem } from '@ocso/audit-store';
import { auditIncidents, auditVerifications, uuidv7, type Db } from '@ocso/db';
import { notFound } from '@ocso/domain';
import type { ActorContext } from '../shared/context.js';
import { recordAudit } from './audit.js';
import { openAuditIncident } from './incidents.js';

/**
 * Chain integrity bookkeeping (ADR-032). A CHAIN_BROKEN incident's `detail`
 * carries where the break is (`firstBrokenAt`–`lastBrokenAt`) and how far the
 * chain has been checked since (`checkedTo`), so the sealer only re-verifies
 * new entries and keeps signing checkpoints over ranges that verify on their
 * own. A person with audit.verify acknowledges the break (audited); the range
 * is then a known, recorded break that later verifications report as such but
 * do not re-open.
 */
export interface ChainBreakDetail {
  driver: string;
  firstBrokenAt: number;
  lastBrokenAt: number;
  checkedTo: number;
  problems: ChainProblem[];
  acknowledged?: { by: string | null; at: string; note: string } | undefined;
}

export type AuditVerification = typeof auditVerifications.$inferSelect;

/** Position ranges of acknowledged breaks: problems inside them are known and recorded. */
export async function acknowledgedBreaks(db: Db): Promise<Array<[number, number]>> {
  const rows = await db
    .select({ detail: auditIncidents.detail })
    .from(auditIncidents)
    .where(and(eq(auditIncidents.kind, 'CHAIN_BROKEN'), isNotNull(auditIncidents.resolvedAt), sql`${auditIncidents.detail} ? 'acknowledged'`));
  return rows.map(({ detail }) => [Number(detail['firstBrokenAt'] ?? 0), Number(detail['lastBrokenAt'] ?? 0)] as [number, number]).filter(([a, b]) => a > 0 && b >= a);
}

export const outsideRanges = (ranges: ReadonlyArray<[number, number]>) => (p: ChainProblem) => !ranges.some(([a, b]) => p.position >= a && p.position <= b);

/** Opens or widens CHAIN_BROKEN with these problems (found while checking up to `checkedTo`). */
export async function noteChainBreak(db: Db, driver: string, problems: readonly ChainProblem[], checkedTo: number, truncatedProblems: boolean): Promise<void> {
  if (!problems.length) return;
  const open = await openAuditIncident(db, 'CHAIN_BROKEN');
  const prev = (open?.detail ?? {}) as Partial<ChainBreakDetail>;
  const positions = problems.map((p) => p.position);
  const detail: ChainBreakDetail = {
    driver,
    firstBrokenAt: Math.min(prev.firstBrokenAt ?? Number.MAX_SAFE_INTEGER, ...positions),
    // More problems than were listed: the break may run to where checking stopped.
    lastBrokenAt: Math.max(prev.lastBrokenAt ?? 0, truncatedProblems ? checkedTo : Math.max(...positions)),
    checkedTo: Math.max(prev.checkedTo ?? 0, checkedTo),
    problems: [...(prev.problems ?? []), ...problems].slice(0, 20),
  };
  await db.execute(sql`
    INSERT INTO audit_incidents (id, kind, detail) VALUES (${uuidv7()}, 'CHAIN_BROKEN', ${JSON.stringify(detail)}::jsonb)
    ON CONFLICT (kind) WHERE resolved_at IS NULL
    DO UPDATE SET last_seen = now(), count = audit_incidents.count + 1, detail = EXCLUDED.detail`);
}

/** Moves an open CHAIN_BROKEN's `checkedTo` forward (a later range verified); no new occurrence. */
export async function advanceChainBreak(db: Db, checkedTo: number): Promise<void> {
  await db.execute(sql`
    UPDATE audit_incidents SET detail = jsonb_set(detail, '{checkedTo}', to_jsonb(GREATEST(coalesce((detail->>'checkedTo')::bigint, 0), ${checkedTo}::bigint)))
     WHERE kind = 'CHAIN_BROKEN' AND resolved_at IS NULL`);
}

/**
 * POST /v1/audit/incidents/:id/acknowledge — a person with audit.verify records
 * that a chain break was investigated. The incident is resolved with who, when
 * and why in its detail, and the acknowledgement is itself audited. The break
 * stays in the store (nothing is rewritten); verifications report it as known.
 */
export async function acknowledgeChainBreak(db: Db, actor: ActorContext, incidentId: string, note: string): Promise<typeof auditIncidents.$inferSelect> {
  return db.transaction(async (tx) => {
    const [incident] = await tx
      .select()
      .from(auditIncidents)
      .where(and(eq(auditIncidents.id, incidentId), eq(auditIncidents.kind, 'CHAIN_BROKEN'), isNull(auditIncidents.resolvedAt)))
      .for('update');
    if (!incident) throw notFound('audit_incident', incidentId);
    const acknowledged = { by: actor.principal?.userId ?? null, at: new Date().toISOString(), note };
    const [updated] = await tx
      .update(auditIncidents)
      .set({ resolvedAt: new Date(), detail: { ...incident.detail, acknowledged } })
      .where(eq(auditIncidents.id, incidentId))
      .returning();
    const d = incident.detail as Partial<ChainBreakDetail>;
    await recordAudit(tx, actor, {
      action: 'audit.chain_acknowledge',
      targetType: 'audit_store',
      targetId: incidentId,
      summary: `Acknowledged the audit chain break at ${d.firstBrokenAt ?? '?'}–${d.lastBrokenAt ?? '?'}: ${note}`,
      after: { incidentId, firstBrokenAt: d.firstBrokenAt ?? null, lastBrokenAt: d.lastBrokenAt ?? null, problems: (d.problems ?? []).slice(0, 5), note },
    });
    return updated!;
  });
}

export interface FullVerifyOptions {
  /** Entries checked per run (the task runs every minute until the chain is done). */
  pageEntries?: number;
  /** Time between full verifications. */
  everyMs?: number;
  now?: () => Date;
}

/**
 * audit-verify-full: the whole chain re-verified periodically (daily by
 * default) in bounded pages, resuming where the previous run stopped, so a
 * record altered long ago is found without anyone running audit-verify by
 * hand. Problems open CHAIN_BROKEN (acknowledged ranges excepted); the System
 * screen shows the last finished run. Leader-only.
 */
export class AuditFullVerifier {
  constructor(
    private readonly db: Db,
    private readonly store: AuditStore,
    private readonly signer: AuditSigner | null,
    private readonly options: FullVerifyOptions = {},
  ) {}

  async run(): Promise<AuditVerification | null> {
    const now = this.options.now?.() ?? new Date();
    let [current] = await this.db.select().from(auditVerifications).where(isNull(auditVerifications.finishedAt)).orderBy(desc(auditVerifications.startedAt)).limit(1);
    if (!current) {
      const [last] = await this.db.select().from(auditVerifications).orderBy(desc(auditVerifications.startedAt)).limit(1);
      if (last && now.getTime() - last.startedAt.getTime() < (this.options.everyMs ?? 24 * 3600 * 1000)) return null;
      const head = await this.store.chainHead();
      if (!head) return null;
      [current] = await this.db.insert(auditVerifications).values({ id: uuidv7(), startedAt: now, updatedAt: now, headAtStart: head.position }).returning();
    }
    const run = current!;
    const page = this.options.pageEntries ?? 50_000;
    const from = run.checkedTo + 1;
    const report = await verifyChain(this.store, { from, to: Math.min(run.headAtStart, from + page - 1), keys: trustedKeys(this.signer), now, maxEntries: page });
    const known = await acknowledgedBreaks(this.db);
    const problems = report.problems.filter(outsideRanges(known));
    await noteChainBreak(this.db, this.store.driver, problems, report.to, report.problems.length >= 100);
    const done = report.to >= run.headAtStart || report.entries === 0;
    const [updated] = await this.db
      .update(auditVerifications)
      .set({
        checkedTo: Math.max(run.checkedTo, report.to),
        entries: run.entries + report.entries,
        ok: run.ok && problems.length === 0,
        problems: [...run.problems, ...problems.map((p) => ({ ...p }))].slice(0, 100),
        updatedAt: now,
        finishedAt: done ? now : null,
      })
      .where(eq(auditVerifications.id, run.id))
      .returning();
    return updated!;
  }
}

export async function lastFullVerification(db: Db): Promise<AuditVerification | null> {
  const [row] = await db.select().from(auditVerifications).where(isNotNull(auditVerifications.finishedAt)).orderBy(desc(auditVerifications.finishedAt)).limit(1);
  return row ?? null;
}
