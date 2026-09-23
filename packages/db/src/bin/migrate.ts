import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createDatabase } from '../client.js';
import { runMigrations } from '../migrate.js';

/**
 * Deployment step entrypoint (Compose `migrate` service / ECS one-off task).
 * Not a product CLI: it takes no arguments and only applies migrations.
 */
const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const dir = process.env['OCSO_MIGRATIONS_DIR'] ?? join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const database = createDatabase({ connectionString: url, maxConnections: 1, applicationName: 'ocso-migrate', ssl: process.env['DATABASE_SSL'] === 'true' });
try {
  const result = await runMigrations(database.pool, dir, (m) => console.log(JSON.stringify({ level: 'info', msg: m })));
  console.log(JSON.stringify({ level: 'info', msg: 'migrations complete', applied: result.applied.length, skipped: result.skipped.length }));
} catch (err) {
  console.error(JSON.stringify({ level: 'error', msg: (err as Error).message }));
  process.exitCode = 1;
} finally {
  await database.close();
}
