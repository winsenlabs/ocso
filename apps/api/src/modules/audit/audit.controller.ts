import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import { AuditQuery, queryAudit } from '@ocso/application';
import type { Db } from '@ocso/db';
import { RequirePermission } from '../../common/decorators.js';
import { DB } from '../../infrastructure/tokens.js';

@Controller('v1/audit')
export class AuditController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @RequirePermission(Permission.AUDIT_READ)
  list(@Query({ schema: AuditQuery }) q: AuditQuery) {
    return queryAudit(this.db, q);
  }
}
