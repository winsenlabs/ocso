import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import { AuditQuery, SettingsService, auditScope, queryAudit } from '@ocso/application';
import type { Db } from '@ocso/db';
import { CurrentPrincipal, RequirePermission } from '../../common/decorators.js';
import { DB } from '../../infrastructure/tokens.js';

@Controller('v1/audit')
export class AuditController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  /** Tech Admins read the whole log; others only what concerns their teams (auditScope). */
  @Get()
  @RequirePermission(Permission.AUDIT_READ)
  async list(@CurrentPrincipal() principal: Principal, @Query({ schema: AuditQuery }) q: AuditQuery) {
    const { execsCanViewAiActive } = await this.settings.deployment();
    return queryAudit(this.db, q, auditScope(principal, { execsCanViewAiActive }));
  }
}
