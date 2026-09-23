import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Permission, type Principal } from '@ocso/auth';
import { ExceptionAdhocInput, ExceptionRegenerateInput, ExceptionReportQuery, ExceptionService, ExceptionSignInput, type ActorContext } from '@ocso/application';
import { Actor, Capability, CurrentPrincipal, RequirePermission } from '../../common/decorators.js';

const Id = z.uuid();
type ListQuery = z.infer<typeof ExceptionReportQuery>;
type SignBody = z.infer<typeof ExceptionSignInput>;
type AdhocBody = z.infer<typeof ExceptionAdhocInput>;
type RegenerateBody = z.infer<typeof ExceptionRegenerateInput>;

/**
 * The exception report (PM/research/11 §7, ADR-033). Reads need
 * exceptions.read and are scoped in the service: readers see their teams'
 * items and platform-wide ones; exceptions.sign holders see the whole report,
 * sign it with the audit signing key, create ad-hoc reports and export signed ones.
 */
@Controller('v1/exceptions')
export class ExceptionsController {
  constructor(@Inject(ExceptionService) private readonly exceptions: ExceptionService) {}

  /** The live view: computed on read over the last seven days (state as of now). */
  @Capability({ name: 'exceptions.get_live_exceptions', summary: 'The live exception view: policy exceptions over the last seven days.' })
  @Get('live')
  @RequirePermission(Permission.EXCEPTIONS_READ)
  live(@CurrentPrincipal() principal: Principal) {
    return this.exceptions.live(principal);
  }

  @Capability({ name: 'exceptions.list_exception_reports', summary: 'List exception reports (drafts and signed).', tags: ['report'] })
  @Get('reports')
  @RequirePermission(Permission.EXCEPTIONS_READ)
  list(@CurrentPrincipal() principal: Principal, @Query({ schema: ExceptionReportQuery }) q: ListQuery) {
    return this.exceptions.list(principal, q);
  }

  /** An ad-hoc report over a past period, frozen as a draft to sign. */
  @Capability({ name: 'exceptions.create_exception_report', summary: 'Create an ad-hoc exception report over a past period (a draft to sign).', risk: 'LOW_WRITE', tags: ['report'] })
  @Post('reports')
  @RequirePermission(Permission.EXCEPTIONS_SIGN)
  adhoc(@Actor() actor: ActorContext, @Body({ schema: ExceptionAdhocInput }) body: AdhocBody) {
    return this.exceptions.generateAdhoc(actor, body);
  }

  @Capability({ name: 'exceptions.get_exception_report', summary: 'Get one exception report.', tags: ['report'] })
  @Get('reports/:id')
  @RequirePermission(Permission.EXCEPTIONS_READ)
  get(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string) {
    return this.exceptions.get(principal, id);
  }

  /** Replaces an unsigned report with a freshly computed one over the same period; the draft is kept as SUPERSEDED. Audited. */
  @Capability({ name: 'exceptions.regenerate_exception_report', summary: 'Recompute an unsigned exception report over the same period.', tags: ['report'] })
  @Post('reports/:id/regenerate')
  @RequirePermission(Permission.EXCEPTIONS_SIGN)
  regenerate(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: ExceptionRegenerateInput }) body: RegenerateBody) {
    return this.exceptions.regenerate(actor, id, body);
  }

  /**
   * Signs a draft report; the caller sends the content hash they were shown and acknowledges the attestation
   * flags that apply (409 attestation_required otherwise). Audited; the report is then immutable.
   */
  @Capability({ name: 'exceptions.sign_exception_report', summary: 'Sign an exception report (with the content hash you were shown).', tags: ['report', 'sign-off'] })
  @Post('reports/:id/sign')
  @HttpCode(200)
  @RequirePermission(Permission.EXCEPTIONS_SIGN)
  sign(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: ExceptionSignInput }) body: SignBody) {
    return this.exceptions.sign(actor, id, body);
  }

  /** The signed export: a zip with report.json, items.csv, the signature, the public key and VERIFY.txt. Audited. */
  @Get('reports/:id/export')
  @RequirePermission(Permission.EXCEPTIONS_SIGN)
  async export(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Res() res: Response) {
    const { fileName, zip } = await this.exceptions.exportBundle(actor, id);
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-disposition', `attachment; filename="${fileName}"`);
    res.setHeader('cache-control', 'no-store');
    res.status(200).send(zip);
  }
}
