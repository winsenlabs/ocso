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
 * Routing backfill (0024_routing + 0025_routing_backfill, PM/research/11 §5.6):
 * a deployment where channels named their agent keeps answering exactly as
 * before — each reachable agent gets a service queue, each such channel a
 * pass-through router to it; duplicate open conversations per (customer,
 * channel) are superseded before the unique index swaps.
 */
const ROUTING = '0024_routing.sql';
const name = `ocso_test_${randomBytes(6).toString('hex')}`;
let database: Database;
let before: string;
const id = {
  cardsTeam: uuidv7(),
  salesTeam: uuidv7(),
  cardsQueue: uuidv7(),
  clashQueue: uuidv7(),
  maya: uuidv7(),
  arjun: uuidv7(),
  riya: uuidv7(),
  twilio: uuidv7(),
  web: uuidv7(),
  attachedOnly: uuidv7(),
  idle: uuidv7(),
  customer: uuidv7(),
  other: uuidv7(),
  convOld: uuidv7(),
  convNew: uuidv7(),
  convNoQueue: uuidv7(),
  convRiya: uuidv7(),
  convResolved: uuidv7(),
  sla: uuidv7(),
  turn: uuidv7(),
  handoff: uuidv7(),
};

const q = (text: string, params: unknown[] = []) => database.pool.query(text, params);

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: testAdminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(testAdminUrl());
  url.pathname = `/${name}`;
  database = createDatabase({ connectionString: url.toString(), maxConnections: 2, applicationName: 'ocso-test' });
  before = await mkdtemp(join(tmpdir(), 'ocso-migrations-'));
  for (const file of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql') && f < ROUTING)) await copyFile(join(MIGRATIONS_DIR, file), join(before, file));
  await runMigrations(database.pool, before);

  // A pre-routing deployment.
  await q(`INSERT INTO teams (id, name) VALUES ($1, 'Cards'), ($2, 'Sales')`, [id.cardsTeam, id.salesTeam]);
  // "Riya" already names a queue: Riya's new service queue needs a suffix.
  await q(`INSERT INTO sla_policies (id, name, first_human_response_seconds) VALUES ($1, 'Cards SLA', 600)`, [id.sla]);
  await q(
    `INSERT INTO queues (id, name, mode, sla_policy_id, languages, after_hours_message) VALUES ($1, 'Cards & EMI', 'AUTO_ASSIGN', $3, '{ta,en}', 'Back at 9'), ($2, 'riya', 'OPEN_PICKUP', NULL, '{}', NULL)`,
    [id.cardsQueue, id.clashQueue, id.sla],
  );
  await q(`INSERT INTO queue_teams (queue_id, team_id) VALUES ($1, $2)`, [id.cardsQueue, id.cardsTeam]);
  await q(
    `INSERT INTO virtual_agents (id, name, slug, conversation_type, default_queue_id, business_hours, created_at) VALUES
       ($1, 'Maya', 'maya', 'SUPPORT', NULL, '{"timezone":"Asia/Kolkata","humanHours":{"mon":["09:00","18:00"]}}', now() - interval '3 days'),
       ($2, 'Arjun', 'arjun', 'SALES', $4, '{"timezone":"UTC","humanHours":{}}', now() - interval '2 days'),
       ($3, 'Riya', 'riya', 'COLLECTIONS', $4, '{"timezone":"UTC","humanHours":{}}', now() - interval '1 day')`,
    [id.maya, id.arjun, id.riya, id.cardsQueue],
  );
  await q(`INSERT INTO agent_teams (agent_id, team_id) VALUES ($1, $3), ($2, $4)`, [id.maya, id.arjun, id.cardsTeam, id.salesTeam]);
  // The live demo: "WhatsApp — Twilio" answers as Maya (no default queue). Web chat answers as Riya, the first
  // agent of the shared Cards queue. "Attached only" reaches Arjun through agent_channels alone. "Idle" reaches nobody.
  await q(
    `INSERT INTO channels (id, kind, name, status, public_key, default_agent_id) VALUES
       ($1, 'TWILIO_WHATSAPP', 'WhatsApp — Twilio', 'ACTIVE', 'pk-tw', $5),
       ($2, 'WEBCHAT', 'Web chat', 'ACTIVE', 'pk-web', $6),
       ($3, 'WHATSAPP', 'Attached only', 'ACTIVE', 'pk-att', NULL),
       ($4, 'WHATSAPP', 'Idle', 'ACTIVE', 'pk-idle', NULL)`,
    [id.twilio, id.web, id.attachedOnly, id.idle, id.maya, id.riya],
  );
  await q(`INSERT INTO agent_channels (agent_id, channel_id) VALUES ($1, $2), ($3, $4), ($5, $6)`, [id.maya, id.twilio, id.riya, id.web, id.arjun, id.attachedOnly]);
  await q(`INSERT INTO customers (id, display_name) VALUES ($1, 'Priya'), ($2, 'Farida')`, [id.customer, id.other]);
  // Two open conversations of one customer on the Twilio channel (its agent changed while one was open).
  await q(
    `INSERT INTO conversations (id, customer_id, agent_id, channel_id, type, control_state, queue_id, opened_at) VALUES
       ($1, $3, $4, $5, 'SALES', 'WAITING_FOR_HUMAN', NULL, now() - interval '2 days'),
       ($2, $3, $6, $5, 'SUPPORT', 'AI_ACTIVE', NULL, now() - interval '1 hour'),
       ($7, $8, $6, $5, 'SUPPORT', 'AI_ACTIVE', NULL, now()),
       ($9, $8, $10, $11, 'COLLECTIONS', 'AI_ACTIVE', NULL, now())`,
    [id.convOld, id.convNew, id.customer, id.arjun, id.twilio, id.maya, id.convNoQueue, id.other, id.convRiya, id.riya, id.web],
  );
  await q(
    `INSERT INTO conversations (id, customer_id, agent_id, channel_id, type, control_state, queue_id, opened_at, resolved_at) VALUES ($1, $2, $3, $4, 'SUPPORT', 'RESOLVED', NULL, now() - interval '3 days', now() - interval '1 day')`,
    [id.convResolved, id.customer, id.maya, id.web],
  );
  await q(`INSERT INTO handoffs (id, conversation_id, trigger, reason_code, reason_text, requested_by_type, mode, priority, status) VALUES ($1, $2, 'CUSTOMER_REQUEST', 'x', 'x', 'CUSTOMER', 'OPEN_PICKUP', 'P3', 'WAITING')`, [id.handoff, id.convOld]);
  await q(`INSERT INTO turns (id, conversation_id, worker_id, lease_version, seq_from, seq_to) VALUES ($1, $2, 'w1', 1, 1, 1)`, [id.turn, id.convNew]);

  await runMigrations(database.pool, MIGRATIONS_DIR);
});
afterAll(async () => {
  await database?.close();
  if (before) await rm(before, { recursive: true, force: true });
  const cleanup = new pg.Client({ connectionString: testAdminUrl() });
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await cleanup.end();
});

const routerOf = async (channelId: string) =>
  (
    await q(
      `SELECT r.name, r.status, v.version, v.definition, (SELECT count(*)::int FROM router_drafts d WHERE d.router_id = r.id) AS drafts
         FROM channels c JOIN routers r ON r.id = c.router_id JOIN router_versions v ON v.id = r.active_version_id WHERE c.id = $1`,
      [channelId],
    )
  ).rows[0];
const queueOf = async (queueId: string) => (await q(`SELECT name, agent_id, business_hours, (SELECT array_agg(team_id::text) FROM queue_teams WHERE queue_id = queues.id) AS teams FROM queues WHERE id = $1`, [queueId])).rows[0];

describe('routing backfill', () => {
  it('the live demo: WhatsApp — Twilio → pass-through router → a new queue "Maya" with Maya and her teams', async () => {
    const router = await routerOf(id.twilio);
    expect(router).toMatchObject({ name: 'WhatsApp — Twilio', status: 'ACTIVE', version: 1, drafts: 1 });
    expect(router.definition).toMatchObject({ steps: [], rules: [], returning: null, timeoutMinutes: 10 });
    const queue = await queueOf(router.definition.fallbackQueueId);
    expect(queue).toMatchObject({ name: 'Maya', agent_id: id.maya, teams: [id.cardsTeam], business_hours: { timezone: 'Asia/Kolkata' } });
  });

  it('an agent whose default queue is free serves it; a second agent of that queue gets its own (suffixed on a name clash)', async () => {
    // Agents are taken oldest first: Arjun (created before Riya) keeps Cards & EMI; Riya gets "Riya (2)" — "riya" was taken.
    const attached = await routerOf(id.attachedOnly);
    expect(attached.definition.fallbackQueueId).toBe(id.cardsQueue);
    expect(await queueOf(id.cardsQueue)).toMatchObject({ name: 'Cards & EMI', agent_id: id.arjun, teams: [id.cardsTeam] });
    const web = await routerOf(id.web);
    expect(await queueOf(web.definition.fallbackQueueId)).toMatchObject({ name: 'Riya (2)', agent_id: id.riya });
    expect((await queueOf(id.clashQueue)).agent_id).toBeNull();
  });

  it('escalations keep their destination: a queue made because of a shared default queue copies its staff, SLA and settings', async () => {
    // Before routing Riya's handoffs went to her default queue, Cards & EMI (Cards team, Cards SLA, auto-assign).
    // Now they go to the conversation's queue: Riya (2), which must reach the same people under the same SLA.
    const riyaQueue = (await routerOf(id.web)).definition.fallbackQueueId;
    const conv = (await q(`SELECT queue_id FROM conversations WHERE id = $1`, [id.convRiya])).rows[0];
    expect(conv.queue_id).toBe(riyaQueue);
    const row = (
      await q(`SELECT mode, sla_policy_id, languages, after_hours_message, (SELECT array_agg(team_id::text) FROM queue_teams WHERE queue_id = queues.id) AS teams FROM queues WHERE id = $1`, [riyaQueue])
    ).rows[0];
    expect(row).toEqual({ mode: 'AUTO_ASSIGN', sla_policy_id: id.sla, languages: ['ta', 'en'], after_hours_message: 'Back at 9', teams: [id.cardsTeam] });
  });

  it('records the migration: one audit entry, a timeline entry on each superseded conversation', async () => {
    const audit = (await q(`SELECT actor_type, actor_id, action, summary, after FROM audit_events WHERE action = 'routing.backfill'`)).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_type: 'SYSTEM', actor_id: 'migration:0025_routing_backfill' });
    expect(audit[0].summary).toContain('3 channel(s) given a pass-through router');
    expect(audit[0].after.superseded).toEqual([{ conversationId: id.convNew, keptConversationId: id.convOld }]);
    const timeline = (
      await q(
        `SELECT i.seq, i.kind, p.content FROM interactions i JOIN interaction_parts p ON p.interaction_id = i.id JOIN conversations c ON c.id = i.conversation_id WHERE i.conversation_id = $1 AND c.last_seq = i.seq`,
        [id.convNew],
      )
    ).rows;
    expect(timeline).toHaveLength(1);
    expect(timeline[0].kind).toBe('SYSTEM_EVENT');
    expect(timeline[0].content.data).toMatchObject({ from: 'AI_ACTIVE', to: 'RESOLVED', keptConversationId: id.convOld });
  });

  it('a channel that reached no agent gets no router', async () => {
    expect((await q(`SELECT router_id FROM channels WHERE id = $1`, [id.idle])).rows[0].router_id).toBeNull();
  });

  it('keeps the open conversation a person is working (over a newer AI one); the other is resolved', async () => {
    const rows = (await q(`SELECT id, control_state, disposition FROM conversations WHERE customer_id = $1 AND channel_id = $2 ORDER BY opened_at`, [id.customer, id.twilio])).rows;
    expect(rows).toMatchObject([
      { id: id.convOld, control_state: 'WAITING_FOR_HUMAN', disposition: null },
      { id: id.convNew, control_state: 'RESOLVED', disposition: 'SUPERSEDED_BY_ROUTING_MIGRATION' },
    ]);
    // The kept conversation's handoff is untouched.
    expect((await q(`SELECT status FROM handoffs WHERE id = $1`, [id.handoff])).rows[0].status).toBe('WAITING');
  });

  it('resolved conversations without a queue join their agent’s service queue too (a reopen lands in a queue)', async () => {
    const maya = (await routerOf(id.twilio)).definition.fallbackQueueId;
    expect((await q(`SELECT queue_id FROM conversations WHERE id = $1`, [id.convResolved])).rows[0].queue_id).toBe(maya);
  });

  it('open conversations without a queue join their agent’s service queue; turns record their agent', async () => {
    const maya = (await routerOf(id.twilio)).definition.fallbackQueueId;
    const conv = (await q(`SELECT queue_id FROM conversations WHERE id = $1`, [id.convNoQueue])).rows[0];
    expect(conv.queue_id).toBe(maya);
    expect((await q(`SELECT agent_id FROM turns WHERE id = $1`, [id.turn])).rows[0].agent_id).toBe(id.maya);
  });

  it('swaps the unique index to one open conversation per (customer, channel)', async () => {
    const idx = (await q(`SELECT indexname FROM pg_indexes WHERE tablename = 'conversations' AND indexname LIKE 'conversations_open%'`)).rows.map((r) => r.indexname);
    expect(idx).toEqual(['conversations_open_channel_uq']);
    await expect(
      q(`INSERT INTO conversations (id, customer_id, agent_id, channel_id, type) VALUES ($1, $2, $3, $4, 'SUPPORT')`, [uuidv7(), id.customer, id.riya, id.twilio]),
    ).rejects.toMatchObject({ constraint: 'conversations_open_channel_uq' });
    // A conversation may have no agent while a router decides (ROUTING)…
    await expect(q(`INSERT INTO conversations (id, customer_id, agent_id, channel_id, type) VALUES ($1, $2, NULL, $3, 'SUPPORT')`, [uuidv7(), id.other, id.idle])).rejects.toMatchObject({
      constraint: 'conversations_agent_or_routing_ck',
    });
    await q(`INSERT INTO conversations (id, customer_id, agent_id, channel_id, type, control_state) VALUES ($1, $2, NULL, $3, 'SUPPORT', 'ROUTING')`, [uuidv7(), id.other, id.idle]);
    // …or it was resolved before a router chose one.
    await q(`INSERT INTO conversations (id, customer_id, agent_id, channel_id, type, control_state, resolved_at) VALUES ($1, $2, NULL, $3, 'SUPPORT', 'RESOLVED', now())`, [uuidv7(), id.other, id.idle]);
  });
});
