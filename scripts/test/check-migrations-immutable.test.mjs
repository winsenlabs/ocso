import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { editedMigrations } from '../check-migrations-immutable.mjs';

describe('check-migrations-immutable', () => {
  test('flags a migration whose content differs from the commit that added it', () => {
    const blobs = { 'c1:a.sql': 'x', 'HEAD:a.sql': 'x', 'c2:b.sql': 'y', 'HEAD:b.sql': 'y-edited', 'c3:c.sql': 'z', 'HEAD:c.sql': 'z' };
    const added = { 'a.sql': 'c1', 'b.sql': 'c2', 'c.sql': 'c3', 'new.sql': null };
    const edited = editedMigrations(['a.sql', 'b.sql', 'c.sql', 'new.sql'], (rev, path) => blobs[`${rev}:${path}`], (path) => added[path]);
    assert.deepEqual(edited, ['b.sql (added in c2)']);
  });
});
