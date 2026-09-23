import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const LOCK_KEY = "hashtext('ocso:migrations')";
const BREAKPOINT = '--> statement-breakpoint';

/**
 * OCSO migration runner (ADR-004). Applies `*.sql` files in filename order
 * under an advisory lock, one transaction per file, and refuses to run when a
 * previously applied file was edited. Invoked only by the explicit migrate
 * deployment step — never from api/worker startup (docs/13 §5).
 */
export async function runMigrations(pool: pg.Pool, dir: string, log: (msg: string) => void = () => {}): Promise<MigrationResult> {
  const client = await pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(${LOCK_KEY})`);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Map(
      (await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const result: MigrationResult = { applied: [], skipped: [] };
    for (const file of files) {
      const text = await readFile(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(text).digest('hex');
      const previous = applied.get(file);
      if (previous) {
        if (previous !== checksum) throw new Error(`migration ${file} was modified after being applied`);
        result.skipped.push(file);
        continue;
      }
      await client.query('BEGIN');
      try {
        for (const statement of text.split(BREAKPOINT)) {
          if (statement.trim()) await client.query(statement);
        }
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        result.applied.push(file);
        log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return result;
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`).catch(() => {});
    client.release();
  }
}
