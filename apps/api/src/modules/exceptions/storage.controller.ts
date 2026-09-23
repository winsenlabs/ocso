import { Controller, Get, Inject } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import { storageReport, type AuditStore } from '@ocso/application';
import type { Db } from '@ocso/db';
import { RequirePermission } from '../../common/decorators.js';
import { AUDIT_STORE, DB } from '../../infrastructure/tokens.js';

/**
 * Storage growth (PM/research/11 §7): the daily table-size samples, their growth
 * and when to move the audit store to ClickHouse. Sizes and counts only.
 */
@Controller('v1/system')
export class StorageController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUDIT_STORE) private readonly store: AuditStore,
  ) {}

  @Get('storage')
  @RequirePermission(Permission.SYSTEM_READ)
  storage() {
    return storageReport(this.db, { auditDriver: this.store.driver, auditSizing: this.store.sizing ?? null });
  }
}
