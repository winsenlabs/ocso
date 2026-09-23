import { describe, expect, it } from 'vitest';
import { checkGrants } from '../src/clickhouse/grants.js';

describe('clickhouse selfCheck: reading SHOW GRANTS', () => {
  it('tells the writer, the read-only reader and over-privileged credentials apart', () => {
    expect(checkGrants('GRANT SELECT, INSERT ON ocso_audit.audit_records TO w\nGRANT SELECT ON ocso_audit.audit_purges TO w\n')).toEqual({ canWrite: true, warnings: [] });
    expect(checkGrants('GRANT SELECT ON ocso_audit.audit_records TO r\nGRANT SELECT ON ocso_audit.audit_chain TO r\n')).toEqual({ canWrite: false, warnings: [] });
    const admin = checkGrants('GRANT ALL ON *.* TO admin WITH GRANT OPTION\n');
    expect(admin.canWrite).toBe(true);
    expect(admin.warnings[0]).toMatch(/append-only is not enforced/);
    expect(checkGrants('GRANT SELECT, ALTER DELETE ON ocso_audit.audit_records TO p\n').warnings[0]).toMatch(/can ALTER audit_records/);
  });
});
