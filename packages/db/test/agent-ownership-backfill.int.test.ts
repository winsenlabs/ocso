import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/client.js';
import { runMigrations } from '../src/migrate.js';
import { uuidv7 } from '../src/ids.js';
import { MIGRATIONS_DIR, testAdminUrl } from '../src/testing.js';

/**
 * ADR-026 backfill (0016_agent_team_ownership): an agent that existed before
 * team ownership is owned by the teams serving its default queue; an agent
 * whose default queue has no team, or that has no default queue, stays
 * unowned (Tech admin only until assigned).
 */

const OWNERSHIP = '0016_agent_team_ownership.sql';
const name = `ocso_test_${randomBytes(6).toString('hex')}`;
let database: Database;
let before: string;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: testAdminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(testAdminUrl());
  url.pathname = `/${name}`;
  database = createDatabase({ connectionString: url.toString(), maxConnections: 2, applicationName: 'ocso-test' });
  // Apply every migration before team ownership, as a pre-upgrade deployment would have.
  before = await mkdtemp(join(tmpdir(), 'ocso-migrations-'));
  for (const file of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql') && f < OWNERSHIP)) await copyFile(join(MIGRATIONS_DIR, file), join(before, file));
  await runMigrations(database.pool, before);
});
afterAll(async () => {
  await database?.close();
  if (before) await rm(before, { recursive: true, force: true });
  const cleanup = new pg.Client({ connectionString: testAdminUrl() });
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await cleanup.end();
});

describe('agent ownership backfill', () => {
  it('owns existing agents by their default queue’s teams and leaves the rest unowned', async () => {
    const q = (text: string, params: unknown[] = []) => database.pool.query(text, params);
    const [cards, loans, idle] = [uuidv7(), uuidv7(), uuidv7()];
    await q(`INSERT INTO teams (id, name) VALUES ($1, 'Cards'), ($2, 'Loans'), ($3, 'Idle')`, [cards, loans, idle]);
    const [shared, teamless] = [uuidv7(), uuidv7()];
    await q(`INSERT INTO queues (id, name) VALUES ($1, 'Shared desk'), ($2, 'No team yet')`, [shared, teamless]);
    await q(`INSERT INTO queue_teams (queue_id, team_id) VALUES ($1, $2), ($1, $3)`, [shared, cards, loans]);
    const [maya, riya, arjun] = [uuidv7(), uuidv7(), uuidv7()];
    await q(
      `INSERT INTO virtual_agents (id, name, slug, conversation_type, default_queue_id) VALUES
         ($1, 'Maya', 'maya', 'SUPPORT', $4), ($2, 'Riya', 'riya', 'COLLECTIONS', $5), ($3, 'Arjun', 'arjun', 'SALES', NULL)`,
      [maya, riya, arjun, shared, teamless],
    );

    const result = await runMigrations(database.pool, MIGRATIONS_DIR);
    expect(result.applied[0]).toBe(OWNERSHIP);

    const { rows } = await q(`SELECT a.name AS agent, t.name AS team FROM agent_teams o JOIN virtual_agents a ON a.id = o.agent_id JOIN teams t ON t.id = o.team_id ORDER BY 1, 2`);
    expect(rows).toEqual([
      { agent: 'Maya', team: 'Cards' },
      { agent: 'Maya', team: 'Loans' },
    ]);
  });
});
