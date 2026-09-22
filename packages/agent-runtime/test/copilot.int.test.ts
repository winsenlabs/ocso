import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PromptService } from '@ocso/application';
import { conversations, copilotSuggestions } from '@ocso/db';
import { SettingsService } from '@ocso/application';
import { ContextBuilder, CopilotService, COPILOT_REQUEST_MARKER, HotContextCache, ModelGateway, UsageRecorder } from '../src/index.js';
import { createRuntimeHarness, type RuntimeHarness } from './harness.js';

let h: RuntimeHarness;
let copilot: CopilotService;
let conversationId: string;

beforeAll(async () => {
  h = await createRuntimeHarness();
  const prompts = new PromptService(h.t.db);
  const draft = await prompts.draft(h.lead.principal!, h.agentId);
  await prompts.saveDraft(h.lead, h.agentId, { ...draft.components, policies: 'Duplicate debits are reversed within 3 working days (policy CRD-114).' });
  const version = await prompts.createVersionFromDraft(h.lead, h.agentId, { reason: 'add card dispute policy' });
  await prompts.activate(h.lead, h.agentId, version.id);
  copilot = new CopilotService({
    db: h.t.db,
    gateway: new ModelGateway(h.t.db, { get: async () => h.adapter }, new UsageRecorder(h.t.db), new SettingsService(h.t.db)),
    context: new ContextBuilder(h.t.db, new HotContextCache(), { historyWindow: 20, mediaWindow: 6, timezone: 'UTC' }),
    capabilitiesFor: async () => ({ imageInput: false, fileInput: false, audioInput: false }),
  });
  conversationId = await h.say('I was charged twice for the same EMI', undefined, 'copilot-visitor');
});
afterAll(async () => {
  await h?.t.drop();
});

const holdByLead = () =>
  h.t.db.update(conversations).set({ controlState: 'HUMAN_ACTIVE', assignedUserId: h.lead.principal!.userId }).where(eq(conversations.id, conversationId));

describe('AI copilot (E7.9)', () => {
  it('is unavailable while the AI owns the conversation', async () => {
    await expect(copilot.draft(h.lead, conversationId, {})).rejects.toMatchObject({ code: 'copilot_unavailable_in_state' });
  });

  it('drafts on the agent prompt prefix, never calls tools and keeps only grounded policy refs', async () => {
    await holdByLead();
    h.adapter.script = [{ text: '<draft>I have confirmed the duplicate debit and started the reversal.</draft>\n<policies>CRD-114, CRD-999</policies>' }];
    const view = await copilot.draft(h.lead, conversationId, { style: 'shorter' });
    expect(view).toMatchObject({ text: 'I have confirmed the duplicate debit and started the reversal.', status: 'READY', agentName: 'Maya', style: 'shorter', basis: { policyRefs: ['CRD-114'] } });

    const request = h.adapter.requests.at(-1)!;
    expect(request.purpose).toBe('COPILOT');
    expect(request.toolChoice).toBe('none');
    expect(request.system.at(-1)).toMatchObject({ key: 'copilot_mode', stable: false });
    expect(request.system.at(-1)!.text).toContain('Anjali Rao');
    expect(JSON.stringify(request.messages.at(-1))).toContain(COPILOT_REQUEST_MARKER);

    const usage = await h.t.db.execute<{ purpose: string; user_id: string }>(sql`SELECT purpose, user_id FROM usage_events WHERE conversation_id = ${conversationId} AND purpose = 'COPILOT'`);
    expect(usage.rows).toEqual([{ purpose: 'COPILOT', user_id: h.lead.principal!.userId }]);
    const events = await h.t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM outbox_events WHERE type = 'copilot.suggestion' AND conversation_id = ${conversationId}`);
    expect(events.rows[0]!.n).toBe(1);
    expect(await copilot.latest(conversationId)).toMatchObject({ id: view.id });
  });

  it('goes stale when the customer writes again, which schedules a proactive draft', async () => {
    const before = { suggest: h.queue.pending('copilot.suggest'), turn: h.queue.pending('conversation.turn') };
    await h.say('Any update?', undefined, 'copilot-visitor');
    expect(await copilot.latest(conversationId)).toBeNull();
    expect(h.queue.pending('copilot.suggest')).toBe(before.suggest + 1);
    expect(h.queue.pending('conversation.turn')).toBe(before.turn);

    const [conv] = await h.t.db.select().from(conversations).where(eq(conversations.id, conversationId));
    h.adapter.script = [{ text: 'Your reversal is in progress and will reflect within 3 working days.' }];
    expect(await copilot.suggest(conversationId, conv!.lastSeq, 'c')).toBe('created');
    expect(await copilot.suggest(conversationId, conv!.lastSeq, 'c')).toBe('skipped');
    const latest = await copilot.latest(conversationId);
    expect(latest).toMatchObject({ text: 'Your reversal is in progress and will reflect within 3 working days.', basis: { policyRefs: [] } });
    const [row] = await h.t.db.select().from(copilotSuggestions).where(eq(copilotSuggestions.id, latest!.id));
    expect(row!.requestedBy).toBeNull();

    await copilot.recordOutcome(h.lead, latest!.id, 'INSERTED');
    expect(await copilot.latest(conversationId)).toBeNull();
  });

  it('respects the agent copilot switch', async () => {
    await h.t.pool.query(`UPDATE virtual_agents SET copilot_enabled = false WHERE id = $1`, [h.agentId]);
    await expect(copilot.draft(h.lead, conversationId, {})).rejects.toMatchObject({ code: 'copilot_disabled' });
    await h.t.pool.query(`UPDATE virtual_agents SET copilot_enabled = true WHERE id = $1`, [h.agentId]);
  });
});
