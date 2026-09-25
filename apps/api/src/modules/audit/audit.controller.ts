import { Body, Controller, Get, HttpCode, Inject, Logger, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Permission, type Principal } from '@ocso/auth';
import type { ApiEnv } from '@ocso/config';
import {
  AuditQuery,
  acknowledgeChainBreak,
  auditPublicKeys,
  auditScope,
  auditStoreStatus,
  readAudit,
  recordAudit,
  verifyAuditRange,
  type ActorContext,
  type AuditSigner,
  type AuditStore,
} from '@ocso/application';
import type { Db } from '@ocso/db';
import { Actor, Capability, CurrentPrincipal, RequireAnyPermission, RequirePermission } from '../../common/decorators.js';
import { AUDIT_SIGNER, AUDIT_STORE, DB, ENV } from '../../infrastructure/tokens.js';

const VerifyInput = z
  .object({
    from: z.number().int().min(1).optional(),
    to: z.number().int().min(1).optional(),
  })
  .refine((v) => v.from === undefined || v.to === undefined || v.from <= v.to, { message: 'from must not exceed to', path: ['from'] });
type VerifyInput = z.infer<typeof VerifyInput>;

const AcknowledgeInput = z.object({ note: z.string().trim().min(10).max(2000) });
type AcknowledgeInput = z.infer<typeof AcknowledgeInput>;
const Id = z.uuid();

/**
 * The audit log (docs/archive/specs/15 §7, ADR-032). Reads come from the audit store merged
 * with events not shipped yet; `x-ocso-audit-source: local` marks an answer
 * served from the main database because the store did not respond.
 */
@Controller('v1/audit')
export class AuditController {
  private readonly logger = new Logger('AuditController');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUDIT_STORE) private readonly store: AuditStore,
    @Inject(AUDIT_SIGNER) private readonly signer: AuditSigner,
    @Inject(ENV) private readonly env: Pick<ApiEnv, 'NODE_ENV'>,
  ) {}

  /** Tech reads the whole log; others what concerns them and their teams (auditScope). */
  @Capability({ name: 'audit.list_audit_events', summary: 'Search the audit log: who changed what and when (by target, actor, action or time).', tags: ['who changed', 'change log'] })
  @Get()
  @RequirePermission(Permission.AUDIT_READ)
  async list(@CurrentPrincipal() principal: Principal, @Query({ schema: AuditQuery }) q: AuditQuery, @Res({ passthrough: true }) res: Response) {
    const { rows, source } = await readAudit(this.store, this.db, q, auditScope(principal), (err) =>
      this.logger.warn(`audit store read failed; serving the local window: ${(err as { code?: string }).code ?? (err as Error).message}`),
    );
    res.setHeader('x-ocso-audit-source', source);
    return rows;
  }

  /** The public keys checkpoints, exports and exception reports verify against (not secret). */
  @Capability({ name: 'audit.list_audit_keys', summary: 'List the public keys audit checkpoints, exports and exception reports verify against.' })
  @Get('keys')
  @RequireAnyPermission(Permission.AUDIT_READ, Permission.AUDIT_VERIFY)
  keys() {
    return auditPublicKeys(this.signer);
  }

  /** Audit store health, shipping lag, sealing, checkpoints, exports and open incidents (System screen). */
  @Capability({ name: 'audit.get_audit_store_status', summary: 'Audit store health: shipping lag, sealing, checkpoints, exports and open incidents.' })
  @Get('store')
  @RequireAnyPermission(Permission.SYSTEM_READ, Permission.AUDIT_VERIFY)
  status() {
    // In production the api should hold the read-only reader credentials; say so when it can write.
    return auditStoreStatus(this.db, this.store, this.signer, { expectReadOnly: this.env.NODE_ENV === 'production' });
  }

  /**
   * Records that a chain break (a CHAIN_BROKEN incident) was investigated: resolves it with who,
   * when and why; audited. Nothing in the store changes; later verifications report the range as known.
   */
  @Capability({ name: 'audit.acknowledge_audit_incident', summary: 'Record that an audit chain-break incident was investigated (resolves it).', tags: ['incident'] })
  @Post('incidents/:id/acknowledge')
  @HttpCode(200)
  @RequirePermission(Permission.AUDIT_VERIFY)
  acknowledge(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: AcknowledgeInput }) body: AcknowledgeInput) {
    return acknowledgeChainBreak(this.db, actor, id, body.note);
  }

  /** Re-verifies a range of the hash chain (default: the latest 10 000 entries); audited. */
  @Capability({ name: 'audit.verify_audit_chain', summary: 'Re-verify a range of the audit hash chain.', risk: 'LOW_WRITE', tags: ['verify', 'integrity'] })
  @Post('verify')
  @HttpCode(200)
  @RequirePermission(Permission.AUDIT_VERIFY)
  async verify(@Actor() actor: ActorContext, @Body({ schema: VerifyInput }) body: VerifyInput) {
    const report = await verifyAuditRange(this.store, this.signer, body);
    await recordAudit(this.db, actor, {
      action: 'audit.verify',
      targetType: 'audit_store',
      summary: report.ok
        ? `Verified the audit chain ${report.from}–${report.to} (${report.entries} entries)`
        : `Audit chain ${report.from}–${report.to} failed verification (${report.problems.length} problems)`,
      after: { from: report.from, to: report.to, ok: report.ok, entries: report.entries, keys: auditPublicKeys(this.signer).map((k) => k.keyId), problems: report.problems.slice(0, 20) },
    });
    return report;
  }
}
