import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { channels, conversations, interactionParts, queues, uuidv7, virtualAgents } from '@ocso/db';
import { MemoryQueue } from '@ocso/queue';
import type { Principal } from '@ocso/auth';
import { AgentService, IngressService, REDACTED_TEXT, RetentionInput, RetentionService, applyDeploymentSettings, effectiveRetention, recordAudit, routeChannelToAgent, systemActor, type ActorContext } from '../src/index.js';
import { createTeam } from './support/ownership.js';
import { makeLive } from './support/live-agent.js';

let t: TestDatabase;
let channelId: string;
const deleted: string[] = [];
const blobs = { delete: async (key: string) => void deleted.push(key) };
const admin: Principal = { userId: uuidv7(), role: 'TECH', displayName: 'Dev', teamIds: [], via: 'UI' };
const ctx = (principal: Principal | null): ActorContext => ({ principal, correlationId: 'test' });
const DAY = 24 * 3600 * 1000;

beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query(`INSERT INTO users (id, email, name, role) VALUES ($1, 'admin@x.test', 'Dev', 'TECH')`, [admin.userId]);
  const owners = await createTeam(t.db);
  const agent = await new AgentService(t.db).create(ctx({ ...admin, role: 'HEAD', teamIds: [owners] }), { name: 'Maya', purpose: 'support', conversationType: 'SUPPORT', description: '', teamIds: [owners] });
  await makeLive(t.db, agent.id);
  channelId = uuidv7();
  await t.db.insert(channels).values({ id: channelId, kind: 'WHATSAPP', name: 'WhatsApp', status: 'ACTIVE', publicKey: 'pk-ret' });
  const queueId = uuidv7();
  await t.db.insert(queues).values({ id: queueId, name: 'Support' });
  await routeChannelToAgent(t.db, ctx(admin), { channelId, agentId: agent.id, queueId });
});
afterAll(async () => {
  await t?.drop();
});

async function conversationWith(phone: string, text: string, withImage = false): Promise<string> {
  const r = await new IngressService(t.db, new MemoryQueue()).receive(channelId, {
    externalMessageId: `m-${uuidv7()}`,
    identityKind: 'whatsapp_phone',
    identityValue: phone,
    alternateIdentities: [],
    profileName: 'Priya',
    receivedAt: new Date(),
    parts: [{ type: 'TEXT', text }, ...(withImage ? [{ type: 'IMAGE' as const, media: { mimeType: 'image/jpeg', status: 'PENDING' as const } }] : [])],
  }, 'c');
  if (r.status !== 'accepted') throw new Error(r.status);
  if (withImage) {
    await t.db.execute(sql`UPDATE interaction_parts SET blob_key = ${`media/${r.conversationId}.jpg`}, media_status = 'STORED',
      content = jsonb_set(jsonb_set(content, '{media,status}', '"STORED"'), '{media,blobKey}', to_jsonb(${`media/${r.conversationId}.jpg`}::text))
      WHERE interaction_id = ${r.interactionId} AND type = 'IMAGE'`);
  }
  return r.conversationId;
}

describe('retention policy (docs/15 §8)', () => {
  it('validates per-class floors and falls back to defaults', () => {
    expect(RetentionInput.safeParse({ auditEvents: 30 }).success).toBe(false);
    expect(RetentionInput.safeParse({ unknownClass: 30 }).success).toBe(false);
    expect(RetentionInput.safeParse({ conversationContent: 30, media: 7 }).success).toBe(true);
    expect(effectiveRetention({ media: 7, auditEvents: 10 })).toMatchObject({ media: 7, auditEvents: 2555, conversationContent: 365 });
  });

  it('purges content of old resolved conversations but keeps structure; leaves open and recent ones alone', async () => {
    // Fixture: the retention an approved settings change leaves (settings changes are proposals).
    await applyDeploymentSettings(t.db, ctx(admin), { retention: { conversationContent: 30, media: 60 } });
    const old = await conversationWith('+919800000001', 'My card 4111 1111 1111 4417 was charged twice', true);
    const recent = await conversationWith('+919800000002', 'recent resolved');
    const open = await conversationWith('+919800000003', 'still open, very old');
    await t.db.update(conversations).set({ controlState: 'RESOLVED', resolvedAt: new Date(Date.now() - 45 * DAY) }).where(eq(conversations.id, old));
    await t.db.update(conversations).set({ controlState: 'RESOLVED', resolvedAt: new Date(Date.now() - 5 * DAY) }).where(eq(conversations.id, recent));
    await t.db.execute(sql`UPDATE interactions SET created_at = now() - interval '400 days' WHERE conversation_id = ${open}`);

    const report = await new RetentionService(t.db, blobs).run();
    expect(report.conversationContent).toBe(1);
    expect(deleted).toContain(`media/${old}.jpg`);

    const parts = await t.db.execute<{ type: string; content: Record<string, unknown>; blob_key: string | null }>(sql`
      SELECT p.type, p.content, p.blob_key FROM interaction_parts p JOIN interactions i ON i.id = p.interaction_id WHERE i.conversation_id = ${old} ORDER BY p.idx`);
    expect(parts.rows).toEqual([
      { type: 'TEXT', content: { type: 'TEXT', text: REDACTED_TEXT }, blob_key: null },
      { type: 'IMAGE', content: { type: 'IMAGE', media: { mimeType: 'image/jpeg', status: 'EXPIRED' } }, blob_key: null },
    ]);
    const [purged] = await t.db.select().from(conversations).where(eq(conversations.id, old));
    expect(purged!.contentPurgedAt).not.toBeNull();
    expect(purged!.lastSeq).toBeGreaterThan(0);

    const kept = await t.db.execute<{ text: string }>(sql`SELECT p.content->>'text' AS text FROM interaction_parts p JOIN interactions i ON i.id = p.interaction_id WHERE i.conversation_id IN (${recent}, ${open})`);
    expect(kept.rows.map((r) => r.text).sort()).toEqual(['recent resolved', 'still open, very old']);
    expect((await new RetentionService(t.db, blobs).run()).conversationContent).toBe(0);
  });

  it('expires old media bytes independently of conversation state', async () => {
    const conv = await conversationWith('+919800000004', 'photo attached', true);
    await t.db.execute(sql`UPDATE interactions SET created_at = now() - interval '90 days' WHERE conversation_id = ${conv}`);
    const report = await new RetentionService(t.db, blobs).run();
    expect(report.media).toBe(1);
    const [part] = await t.db.select().from(interactionParts).where(eq(interactionParts.type, 'IMAGE')).orderBy(sql`${interactionParts.id} DESC`).limit(1);
    expect(part).toMatchObject({ blobKey: null, mediaStatus: 'EXPIRED' });
    expect((part!.content as { media: Record<string, unknown> }).media).toEqual({ mimeType: 'image/jpeg', status: 'EXPIRED' });
  });

  it('deletes audit rows only past the retention cutoff, with a database floor of 365 days', async () => {
    const actor = systemActor('test', 'c');
    await t.db.transaction((tx) => recordAudit(tx, actor, { action: 'test.ancient', targetType: 'x', summary: 'old' }));
    await t.db.execute(sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable`);
    await t.db.execute(sql`UPDATE audit_events SET occurred_at = now() - interval '3000 days' WHERE action = 'test.ancient'`);
    await t.db.execute(sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable`);

    // The trigger refuses a cutoff younger than 365 days even if someone sets it.
    await expect(
      t.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('ocso.audit_retention_cutoff', ${new Date().toISOString()}, true)`);
        await tx.execute(sql`DELETE FROM audit_events WHERE action = 'test.ancient'`);
      }),
    ).rejects.toThrow();
    await expect(t.db.execute(sql`DELETE FROM audit_events WHERE action = 'test.ancient'`)).rejects.toThrow();

    const report = await new RetentionService(t.db, blobs).run();
    expect(report.auditEvents).toBe(1);
    const { rows } = await t.db.execute<{ action: string }>(sql`SELECT action FROM audit_events WHERE action IN ('test.ancient', 'retention.applied')`);
    expect(rows.map((r) => r.action)).not.toContain('test.ancient');
    expect(rows.map((r) => r.action)).toContain('retention.applied');
  });
});
