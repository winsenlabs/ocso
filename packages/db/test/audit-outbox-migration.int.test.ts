import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/client.js';
import { uuidv7 } from '../src/ids.js';
import { runMigrations } from '../src/migrate.js';
import { MIGRATIONS_DIR, testAdminUrl } from '../src/testing.js';

/**
 * Migration 0026 (ADR-032) on a database that already has audit history:
 * existing rows get their team_ids backfilled (the target's teams ∪ an agent
 * actor's teams — never a user actor's current teams, which may not be the
 * teams they acted for), stay unshipped (the shipper sends the whole
 * history), and the replaced trigger still refuses everything but the two stamps.
 */
let database: Database;
let name: string;
let before: string;
const team = uuidv7();
const other = uuidv7();
const user = uuidv7();
const agent = uuidv7();
const conversation = uuidv7();
const toolCall = uuidv7();
const ids = { agentChange: uuidv7(), userChange: uuidv7(), unrelated: uuidv7(), agentActor: uuidv7(), badId: uuidv7(), toolCall: uuidv7(), userOnly: uuidv7() };

beforeAll(async () => {
  name = `ocso_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: testAdminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(testAdminUrl());
  url.pathname = `/${name}`;
  database = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
  // Everything before 0026, then legacy audit rows, then the rest.
  before = mkdtempSync(join(tmpdir(), 'ocso-mig-'));
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f < '0026')) cpSync(join(MIGRATIONS_DIR, file), join(before, file));
  await runMigrations(database.pool, before);
  const q = (sql: string, params: unknown[] = []) => database.pool.query(sql, params);
  await q(`INSERT INTO teams (id, name) VALUES ($1, 'Cards'), ($2, 'Sales')`, [team, other]);
  await q(`INSERT INTO users (id, email, name, role) VALUES ($1, 'lead@x.test', 'Lead', 'HEAD')`, [user]);
  await q(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [team, user]);
  await q(`INSERT INTO virtual_agents (id, name, slug, conversation_type) VALUES ($1, 'Maya', 'maya', 'SUPPORT')`, [agent]);
  await q(`INSERT INTO agent_teams (agent_id, team_id) VALUES ($1, $2)`, [agent, other]);
  const customer = uuidv7();
  await q(`INSERT INTO customers (id, display_name) VALUES ($1, 'Priya')`, [customer]);
  await q(`INSERT INTO conversations (id, customer_id, agent_id, type) VALUES ($1, $2, $3, 'SUPPORT')`, [conversation, customer, agent]);
  await q(`INSERT INTO tool_calls (id, conversation_id, tool_name, actor_type, actor_id, args_sanitized, args_hash, status) VALUES ($1, $2, 'lookup', 'AGENT', $3, '{}', 'h', 'SUCCEEDED')`, [toolCall, conversation, agent]);
  const audit = `INSERT INTO audit_events (id, actor_type, actor_id, via, action, target_type, target_id, summary) VALUES ($1, $2, $3, 'UI', $4, $5, $6, 's')`;
  await q(audit, [ids.agentChange, 'USER', user, 'agent.update', 'agent', agent]);
  await q(audit, [ids.userChange, 'SYSTEM', 'retention', 'user.update', 'user', user]);
  await q(audit, [ids.unrelated, 'SYSTEM', 'retention', 'retention.applied', 'deployment', null]);
  await q(audit, [ids.agentActor, 'AGENT', agent, 'handoff.create', 'handoff', uuidv7()]);
  await q(audit, [ids.badId, 'SYSTEM', 'not-a-uuid', 'agent.update', 'agent', 'not-a-uuid']);
  await q(audit, [ids.toolCall, 'USER', user, 'tool.approve', 'tool_call', toolCall]);
  await q(audit, [ids.userOnly, 'USER', user, 'deployment.update', 'deployment', null]);
  await runMigrations(database.pool, MIGRATIONS_DIR);
});
afterAll(async () => {
  await database?.close();
  rmSync(before, { recursive: true, force: true });
  const admin = new pg.Client({ connectionString: testAdminUrl() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
});

describe('migration 0026_audit_outbox on existing audit history', () => {
  it("backfills team_ids from the target's teams and an agent actor's teams, leaving rows to ship", async () => {
    const { rows } = await database.pool.query<{ id: string; team_ids: string[]; shipped_at: Date | null }>('SELECT id, team_ids, shipped_at FROM audit_events');
    const byId = new Map(rows.map((r) => [r.id, r]));
    // The target agent's team only: the user actor's current team is not assumed to be the one they acted for.
    expect(byId.get(ids.agentChange)!.team_ids).toEqual([other]);
    expect(byId.get(ids.userChange)!.team_ids).toEqual([team]);
    expect(byId.get(ids.unrelated)!.team_ids).toEqual([]);
    expect(byId.get(ids.agentActor)!.team_ids).toEqual([other]);
    expect(byId.get(ids.toolCall)!.team_ids).toEqual([other]);
    expect(byId.get(ids.userOnly)!.team_ids).toEqual([]);
    // Ids that are not uuids are skipped, never cast (no error, no teams).
    expect(byId.get(ids.badId)!.team_ids).toEqual([]);
    expect(rows.every((r) => r.shipped_at === null)).toBe(true);
  });

  it('adds the local window setting with its floor, and keeps the trigger on', async () => {
    const { rows } = await database.pool.query<{ days: number }>('SELECT audit_local_window_days AS days FROM deployment_settings');
    expect(rows[0]!.days).toBe(90);
    await expect(database.pool.query('UPDATE deployment_settings SET audit_local_window_days = 89')).rejects.toThrow(/deployment_settings_audit_window_ck/);
    await expect(database.pool.query(`UPDATE audit_events SET team_ids = '{}' WHERE id = $1`, [ids.agentChange])).rejects.toThrow(/append-only/);
    await expect(database.pool.query('UPDATE audit_events SET verified_at = now() WHERE id = $1', [ids.agentChange])).rejects.toThrow(/append-only/);
    await database.pool.query('UPDATE audit_events SET shipped_at = now() WHERE id = $1', [ids.agentChange]);
    await database.pool.query('UPDATE audit_events SET verified_at = now() WHERE id = $1', [ids.agentChange]);
    const { rows: triggers } = await database.pool.query<{ tgenabled: string }>(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'audit_events_immutable'`);
    expect(triggers[0]!.tgenabled).toBe('O');
  });

  it('keeps at most one open incident per kind', async () => {
    await database.pool.query(`INSERT INTO audit_incidents (id, kind) VALUES ($1, 'STORE_DOWN')`, [uuidv7()]);
    await expect(database.pool.query(`INSERT INTO audit_incidents (id, kind) VALUES ($1, 'STORE_DOWN')`, [uuidv7()])).rejects.toThrow(/audit_incidents_open_uq/);
    await expect(database.pool.query(`INSERT INTO audit_incidents (id, kind) VALUES ($1, 'OTHER')`, [uuidv7()])).rejects.toThrow(/audit_incidents_kind_ck/);
  });
});
