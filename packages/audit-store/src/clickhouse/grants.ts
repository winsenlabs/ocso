import type { AuditStoreSelfCheck } from '../contract.js';

/**
 * What `SHOW GRANTS` says these ClickHouse credentials may do to the audit
 * tables: whether they can insert (the writer) or only read (the api's
 * reader), and any grant broad enough to defeat append-only.
 */
export function checkGrants(showGrants: string): AuditStoreSelfCheck {
  const grants = showGrants.split('\n').filter((l) => l.trim());
  const all = grants.some((g) => /GRANT ALL\b/i.test(g) || /\bON \*\.\*/i.test(g));
  const alter = grants.some((g) => /\bALTER\b/i.test(g) && /audit_records|\.\*/.test(g));
  const warnings: string[] = [];
  if (all) warnings.push('these ClickHouse credentials hold broad grants (ALL or *.*): append-only is not enforced (use the writer/reader users audit-migrate provisions)');
  else if (alter) warnings.push('these ClickHouse credentials can ALTER audit_records (delete or drop partitions)');
  return { canWrite: all || grants.some((g) => /\bINSERT\b/i.test(g)), warnings };
}
