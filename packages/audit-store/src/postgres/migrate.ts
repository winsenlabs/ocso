import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/** The postgres driver's schema, shipped with the package (`files: migrations`). */
export const POSTGRES_AUDIT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/postgres', import.meta.url));

const BREAKPOINT = '--> statement-breakpoint';
const LOCK = "hashtext('ocso:audit-migrations')";

/**
 * Applies the audit database's migrations: the same rules as the main runner
 * (ADR-004) — filename order, one transaction per file, a checksum per applied
 * file, refusal to run when an applied file changed — in its own table
 * `audit_schema_migrations`, in the audit database only.
 */
export async function runAuditMigrations(client: pg.ClientBase, dir: string = POSTGRES_AUDIT_MIGRATIONS_DIR, log: (msg: string) => void = () => {}): Promise<string[]> {
  await client.query(`SELECT pg_advisory_lock(${LOCK})`);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS audit_schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Map((await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM audit_schema_migrations')).rows.map((r) => [r.name, r.checksum]));
    const out: string[] = [];
    for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      const text = await readFile(`${dir}/${file}`, 'utf8');
      const checksum = createHash('sha256').update(text).digest('hex');
      const previous = applied.get(file);
      if (previous) {
        if (previous !== checksum) throw new Error(`audit migration ${file} was modified after being applied`);
        continue;
      }
      await client.query('BEGIN');
      try {
        for (const statement of text.split(BREAKPOINT)) if (statement.trim()) await client.query(statement);
        await client.query('INSERT INTO audit_schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`audit migration ${file} failed: ${(err as Error).message}`);
      }
      out.push(file);
      log(`applied audit migration ${file}`);
    }
    return out;
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${LOCK})`).catch(() => {});
  }
}
