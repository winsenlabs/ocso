import { randomUUID } from 'node:crypto';
import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Permission, assertCan, type Principal } from '@ocso/auth';
import { publicKeyOf, trustedKeys, type AuditSigner } from '@ocso/audit-store';
import { exceptionReports, users, uuidv7, type Db } from '@ocso/db';
import { conflict, notFound, validation, DomainError, ErrorCategory } from '@ocso/domain';
import type { ApprovalRegistry } from '../approvals/registry.js';
import { recordAudit } from '../audit/audit.js';
import { SettingsService } from '../settings/settings.js';
import { systemActor, type ActorContext } from '../shared/context.js';
import { accessSelfApproved, requiredAttestation } from './attestation.js';
import { computeExceptions, scopeContent, seesWholeReport } from './compute.js';
import type { ExceptionReportContent } from './contract.js';
import { buildExportBundle, exportFileName } from './export.js';
import { computeReport, dataFromOf, generateWeeklyReports, insertReport, type GenerationDeps, type WeeklyOutcome } from './generation.js';
import type { ExceptionAdhocInput, ExceptionReportQuery, ExceptionSignInput } from './inputs.js';
import { ADHOC_LOOKBACK_DAYS, liveWindow, safeZone } from './periods.js';
import { noteHash, reportSignatureMessage, verifyReportSignature, type ReportSignatureCheck } from './signing.js';
import { reportSummary, type ExceptionReportDetail, type ExceptionReportSummary } from './views.js';

type Row = typeof exceptionReports.$inferSelect;

export interface ExceptionServiceDeps {
  /** The audit signing key (api only); signing needs it. */
  signer?: AuditSigner | null | undefined;
  now?: (() => Date) | undefined;
  /** Full errors of failed checks (the report stores only their class). */
  log?: ((message: string, err: unknown) => void) | undefined;
}

/**
 * The exception report (PM/research/11 §7, ADR-033): the live view, the weekly
 * chain, ad-hoc reports, regenerating a draft, signing with the audit signing
 * key (with the signer's attestation), and the signed export. Readers with
 * exceptions.read see their teams' items plus platform-wide ones (and items
 * their role reads deployment-wide); exceptions.sign holders see and sign the whole report.
 */
export class ExceptionService {
  constructor(
    private readonly db: Db,
    private readonly registry: ApprovalRegistry,
    private readonly deps: ExceptionServiceDeps = {},
  ) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private generation(now: Date): GenerationDeps {
    return { db: this.db, registry: this.registry, now, onCheckError: (check, err) => this.deps.log?.(`exception check ${check} failed`, err) };
  }

  async live(principal: Principal): Promise<{ content: ExceptionReportContent; scoped: boolean }> {
    assertCan(principal, Permission.EXCEPTIONS_READ);
    const now = this.now();
    const settings = await new SettingsService(this.db).deployment();
    const content = await computeExceptions(this.db, this.registry, {
      period: liveWindow(now),
      now,
      mode: 'LIVE',
      timezone: safeZone(settings.timezone),
      approvalAgeWarningHours: settings.approvalAgeWarningHours,
      dataFrom: dataFromOf(settings, now),
      onCheckError: this.generation(now).onCheckError,
    });
    return scopeContent(content, principal);
  }

  async list(principal: Principal, q: ExceptionReportQuery): Promise<{ rows: ExceptionReportSummary[]; next: { before: string; beforeId: string } | null }> {
    assertCan(principal, Permission.EXCEPTIONS_READ);
    const where: SQL[] = [];
    if (q.kind) where.push(eq(exceptionReports.kind, q.kind));
    if (q.status) where.push(eq(exceptionReports.status, q.status));
    if (q.before && q.beforeId) {
      const before = new Date(q.before);
      where.push(or(lt(exceptionReports.periodStart, before), and(eq(exceptionReports.periodStart, before), lt(exceptionReports.id, q.beforeId)))!);
    }
    const found = await this.select()
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(exceptionReports.periodStart), desc(exceptionReports.id))
      .limit(q.limit + 1);
    const page = found.slice(0, q.limit);
    const last = page.at(-1);
    return {
      rows: page.map((r) => reportSummary(r, principal)),
      next: found.length > q.limit && last ? { before: last.report.periodStart.toISOString(), beforeId: last.report.id } : null,
    };
  }

  async get(principal: Principal, id: string): Promise<ExceptionReportDetail> {
    assertCan(principal, Permission.EXCEPTIONS_READ);
    const row = await this.load(id);
    const whole = seesWholeReport(principal);
    const r = row.report;
    const stored = r.content as unknown as ExceptionReportContent;
    const { content } = scopeContent(stored, principal);
    const draft = r.status === 'DRAFT';
    const signBlocked = !whole ? null : r.status === 'SIGNED' ? 'signed' : r.status === 'SUPERSEDED' ? 'superseded' : !this.deps.signer ? 'signing_key_unavailable' : null;
    return {
      ...reportSummary(row, principal),
      signNote: r.signNote,
      keyId: r.keyId,
      signature: whole ? r.signature : null,
      verification: r.status === 'SIGNED' ? this.verifyRow(r) : null,
      keyTrust: r.status === 'SIGNED' ? this.keyTrust(r.keyId) : null,
      content,
      canSign: whole && signBlocked === null,
      signBlocked,
      attestationRequired: whole && draft ? requiredAttestation(stored, principal.userId, await accessSelfApproved(this.db, principal.userId)) : [],
      canRegenerate: whole && draft,
      canExport: whole && r.status === 'SIGNED',
    };
  }

  /**
   * Freezes every complete weekly period not yet frozen (the chain, generation.ts) as DRAFT reports: nothing
   * before setup is complete; idempotent (the no-overlap constraint makes a second leader a no-op).
   */
  async generateWeekly(correlationId: string = randomUUID()): Promise<WeeklyOutcome> {
    const now = this.now();
    const settings = await new SettingsService(this.db).deployment();
    return generateWeeklyReports(this.generation(now), settings, systemActor('exception-weekly', correlationId, 'Weekly exception report'));
  }

  /** An ad-hoc report over a past period (exceptions.sign): same checks, frozen as a DRAFT to sign. */
  async generateAdhoc(actor: ActorContext, input: ExceptionAdhocInput): Promise<ExceptionReportDetail> {
    const principal = actor.principal!;
    assertCan(principal, Permission.EXCEPTIONS_SIGN);
    const now = this.now();
    const period = { start: new Date(input.periodStart), end: new Date(input.periodEnd) };
    if (period.end > now) throw validation('period_not_over', 'An ad-hoc report covers a period that has ended.');
    if (period.start.getTime() < now.getTime() - ADHOC_LOOKBACK_DAYS * 86_400_000) {
      throw validation('period_too_old', `An ad-hoc report starts within the last ${ADHOC_LOOKBACK_DAYS} days (the audit events it reads are kept locally that long).`);
    }
    const settings = await new SettingsService(this.db).deployment();
    const raw = await computeReport(this.generation(now), settings, period, 'ADHOC', safeZone(settings.timezone));
    const id = await this.db.transaction((tx) => insertReport(tx, actor, { kind: 'ADHOC', period, raw, now, generatedBy: principal.userId }));
    return this.get(principal, id!);
  }

  /**
   * Replaces a DRAFT report with a freshly computed one over the same period (exceptions.sign): the draft
   * becomes SUPERSEDED (kept, pointing at its successor). For a draft whose checks failed or was wrong.
   */
  async regenerate(actor: ActorContext, id: string, input: { reason: string }): Promise<ExceptionReportDetail> {
    const principal = actor.principal!;
    assertCan(principal, Permission.EXCEPTIONS_SIGN);
    const { report: old } = await this.load(id);
    if (old.status !== 'DRAFT') throw conflict(old.status === 'SIGNED' ? 'report_signed' : 'report_superseded', 'Only an unsigned, current report can be regenerated.');
    const now = this.now();
    const settings = await new SettingsService(this.db).deployment();
    const zone = (old.content as unknown as ExceptionReportContent).period?.timezone ?? safeZone(settings.timezone);
    const period = { start: old.periodStart, end: old.periodEnd };
    const raw = await computeReport(this.generation(now), settings, period, old.kind, zone);
    const nextId = uuidv7();
    await this.db.transaction(async (tx) => {
      const [locked] = await tx.select({ status: exceptionReports.status }).from(exceptionReports).where(eq(exceptionReports.id, id)).for('update');
      if (locked?.status !== 'DRAFT') throw conflict('report_changed', 'The report was signed or regenerated meanwhile. Reload it.');
      await tx.update(exceptionReports).set({ status: 'SUPERSEDED', supersededBy: nextId }).where(eq(exceptionReports.id, id));
      await recordAudit(tx, actor, {
        action: 'exception_report.regenerate',
        targetType: 'exception_report',
        targetId: id,
        summary: `Regenerated the ${old.kind.toLowerCase()} exception report for ${old.periodStart.toISOString().slice(0, 10)} – ${old.periodEnd.toISOString().slice(0, 10)}: ${input.reason}`,
        before: { contentHash: old.contentHash, totals: (old.content as unknown as ExceptionReportContent).totals },
        after: { supersededBy: nextId, reason: input.reason },
      });
      await insertReport(tx, actor, { id: nextId, kind: old.kind, period, raw, now, generatedBy: principal.userId });
    });
    return this.get(principal, nextId);
  }

  /**
   * Signs a DRAFT report (exceptions.sign) with the audit signing key (signing.ts: the spec's six lines, the
   * attestation and the note's hash). The signer must have been shown the current content hash and must
   * acknowledge every attestation flag that applies to them (409 attestation_required). Audited; the row,
   * with the public key it was signed with, is then immutable (trigger).
   */
  async sign(actor: ActorContext, id: string, input: Pick<ExceptionSignInput, 'note' | 'contentHash' | 'acknowledge'>): Promise<ExceptionReportDetail> {
    const principal = actor.principal!;
    assertCan(principal, Permission.EXCEPTIONS_SIGN);
    const signer = this.deps.signer;
    if (!signer) throw new DomainError(ErrorCategory.PROVIDER_UNAVAILABLE, 'signing_key_unavailable', 'The audit signing key is not configured on this server.');
    await this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(exceptionReports).where(eq(exceptionReports.id, id)).for('update');
      if (!r) throw notFound('exception_report', id);
      if (r.status === 'SIGNED') throw conflict('report_signed', 'This report is already signed.');
      if (r.status === 'SUPERSEDED') throw conflict('report_superseded', 'This report was replaced by a regenerated one. Sign that one.');
      if (r.contentHash !== input.contentHash) throw conflict('report_changed', 'The report you were shown is not this report. Reload it before signing.');
      const content = r.content as unknown as ExceptionReportContent;
      const attestation = requiredAttestation(content, principal.userId, await accessSelfApproved(tx, principal.userId)).sort();
      const acknowledged = new Set(input.acknowledge ?? []);
      const missing = attestation.filter((f) => !acknowledged.has(f));
      if (missing.length) {
        throw new DomainError(ErrorCategory.CONFLICT, 'attestation_required', 'Acknowledge what this sign-off attests before signing.', { required: missing });
      }
      // Stored timestamps keep microseconds, Dates milliseconds: sign exactly what is read back.
      const signedAt = new Date(Math.floor(this.now().getTime()));
      const note = input.note?.trim() || null;
      const message = reportSignatureMessage({ id: r.id, period: { start: r.periodStart, end: r.periodEnd }, contentHash: r.contentHash, signedBy: principal.userId, signedAt, attestation, signNote: note });
      const signature = signer.sign(message);
      await tx
        .update(exceptionReports)
        .set({ status: 'SIGNED', signedAt, signedBy: principal.userId, signNote: note, signature, keyId: signer.keyId, publicKeyPem: publicKeyOf(signer).publicKeyPem, attestation })
        .where(eq(exceptionReports.id, id));
      await recordAudit(tx, actor, {
        action: 'exception_report.sign',
        targetType: 'exception_report',
        targetId: id,
        summary: `Signed the ${r.kind.toLowerCase()} exception report for ${r.periodStart.toISOString().slice(0, 10)} – ${r.periodEnd.toISOString().slice(0, 10)}${attestation.includes('self_attested') ? ' (self-attested)' : ''}`,
        after: { contentHash: r.contentHash, keyId: signer.keyId, signedAt: signedAt.toISOString(), note, noteSha256: noteHash(note), attestation, selfAttested: attestation.includes('self_attested'), totals: content.totals },
      });
    });
    return this.get(principal, id);
  }

  /** The signed export bundle (zip) — signers only; the whole report or nothing. Audited. Uses the key stored at signing. */
  async exportBundle(actor: ActorContext, id: string): Promise<{ fileName: string; zip: Buffer }> {
    const principal = actor.principal!;
    assertCan(principal, Permission.EXCEPTIONS_SIGN);
    const { report: r, signerName } = await this.load(id);
    if (r.status !== 'SIGNED' || !r.signedAt || !r.signedBy || !r.signature || !r.keyId || !r.publicKeyPem) throw conflict('report_not_signed', 'Only a signed report can be exported.');
    const zip = buildExportBundle(
      {
        id: r.id,
        kind: r.kind,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        content: r.content as unknown as ExceptionReportContent,
        contentHash: r.contentHash,
        generatedAt: r.generatedAt,
        signedAt: r.signedAt,
        signedBy: { id: r.signedBy, name: signerName ?? 'Unknown user' },
        signNote: r.signNote,
        attestation: [...r.attestation],
        signature: r.signature,
        keyId: r.keyId,
        keyTrust: this.keyTrust(r.keyId),
      },
      { keyId: r.keyId, algorithm: 'Ed25519', publicKeyPem: r.publicKeyPem },
    );
    await this.db.transaction((tx) =>
      recordAudit(tx, actor, {
        action: 'exception_report.export',
        targetType: 'exception_report',
        targetId: id,
        summary: `Exported the signed exception report for ${r.periodStart.toISOString().slice(0, 10)} – ${r.periodEnd.toISOString().slice(0, 10)}`,
        after: { contentHash: r.contentHash, keyId: r.keyId },
      }),
    );
    return { fileName: exportFileName(r), zip };
  }

  private keyTrust(keyId: string | null): 'CURRENT' | 'RETIRED' | 'UNKNOWN' {
    if (keyId && this.deps.signer?.keyId === keyId) return 'CURRENT';
    return trustedKeys(this.deps.signer ?? null).some((k) => k.keyId === keyId) ? 'RETIRED' : 'UNKNOWN';
  }

  /** Content and signature against the key stored at signing (trust in that key is keyTrust's question). */
  private verifyRow(r: Row): ReportSignatureCheck {
    if (!r.signature || !r.keyId || !r.signedAt || !r.signedBy || !r.publicKeyPem) return 'INVALID';
    return verifyReportSignature(
      {
        id: r.id,
        period: { start: r.periodStart, end: r.periodEnd },
        contentHash: r.contentHash,
        signedBy: r.signedBy,
        signedAt: r.signedAt,
        attestation: r.attestation,
        signNote: r.signNote,
        content: r.content,
        keyId: r.keyId,
        signature: r.signature,
      },
      [{ keyId: r.keyId, algorithm: 'Ed25519', publicKeyPem: r.publicKeyPem }],
    );
  }

  private select() {
    const generator = alias(users, 'generator');
    const signerUser = alias(users, 'signer');
    return this.db
      .select({ report: exceptionReports, generatorName: generator.name, signerName: signerUser.name })
      .from(exceptionReports)
      .leftJoin(generator, eq(generator.id, exceptionReports.generatedBy))
      .leftJoin(signerUser, eq(signerUser.id, exceptionReports.signedBy));
  }

  private async load(id: string) {
    const [row] = await this.select().where(eq(exceptionReports.id, id));
    if (!row) throw notFound('exception_report', id);
    return row;
  }
}
