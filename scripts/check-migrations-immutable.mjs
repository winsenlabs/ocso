/**
 * Applied migrations are immutable: the migrators checksum every applied file and refuse to start when one
 * changed ("migration 0001_guards.sql was modified after being applied"). Fails when a committed migration differs
 * from the version that first added it to the history. New migrations are fine; so is restoring an edited one.
 *
 *   node scripts/check-migrations-immutable.mjs   (needs the full history: actions/checkout fetch-depth 0)
 */
import { execFileSync } from 'node:child_process';

export const MIGRATION_DIRS = ['packages/db/migrations', 'packages/audit-store/migrations'];

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

/** Migrations whose committed content is not the content they were added with: `path (added in <sha>)`. */
export function editedMigrations(files, blobAt, firstAdded) {
  const edited = [];
  for (const path of files) {
    const added = firstAdded(path);
    if (added && blobAt(added, path) !== blobAt('HEAD', path)) edited.push(`${path} (added in ${added.slice(0, 7)})`);
  }
  return edited;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = git('ls-tree', '-r', '--name-only', 'HEAD', '--', ...MIGRATION_DIRS).split('\n').filter((f) => f.endsWith('.sql'));
  const edited = editedMigrations(
    files,
    (rev, path) => git('rev-parse', `${rev}:${path}`),
    (path) => git('log', '--diff-filter=A', '--format=%H', '--', path).split('\n').filter(Boolean).at(-1) ?? null,
  );
  if (edited.length) {
    console.error(`Applied migrations must not change (a deployed migrator refuses to start). Restore them and add a new migration instead:\n${edited.map((e) => `  ${e}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`ok: ${files.length} migrations match the versions they were added with.`);
}
