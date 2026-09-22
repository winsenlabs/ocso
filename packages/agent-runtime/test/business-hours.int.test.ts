import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { conversations, handoffs } from '@ocso/db';
import { AgentPatch, AgentService } from '@ocso/application';
import { WEEKDAYS, formatOpening, nextOpening, type BusinessHoursLike } from '@ocso/domain';
import { DEFAULT_HANDOFF_MESSAGE, handoffMessage } from '../src/index.js';
import { createRuntimeHarness, turnMessage, type RuntimeHarness } from './harness.js';

/**
 * The AI answers 24×7; business hours only govern humans. A handoff outside
 * human hours still routes to the queue, and the customer is told when the
 * team is next available (agent time zone).
 */

let h: RuntimeHarness;

beforeAll(async () => {
  h = await createRuntimeHarness();
});
afterAll(async () => {
  await h?.t.drop();
});
beforeEach(async () => {
  h.adapter.script = [];
  await h.t.pool.query(`UPDATE conversations SET control_state = 'RESOLVED', resolved_at = now() - interval '10 days' WHERE control_state <> 'RESOLVED'`);
  await h.t.pool.query('DELETE FROM conversation_leases');
});

const setHours = (businessHours: BusinessHoursLike) => new AgentService(h.t.db).update(h.lead, h.agentId, AgentPatch.parse({ businessHours }));
const agentMessages = async (conversationId: string) =>
  (await h.t.pool.query(`SELECT p.content->>'text' AS text FROM interactions i JOIN interaction_parts p ON p.interaction_id = i.id WHERE i.conversation_id = $1 AND i.actor_type = 'AGENT' ORDER BY i.seq`, [conversationId])).rows.map(
    (r: { text: string }) => r.text,
  );

/** Hours open only on the day after tomorrow (Kolkata), so "now" is always outside them. */
function closedNow(): BusinessHoursLike {
  const local = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(new Date()).toLowerCase().slice(0, 3);
  const today = WEEKDAYS.indexOf(local as (typeof WEEKDAYS)[number]);
  return { timezone: 'Asia/Kolkata', humanHours: { [WEEKDAYS[(today + 2) % 7]!]: ['09:00', '17:00'] } };
}
const openNow = (): BusinessHoursLike => ({ timezone: 'Asia/Kolkata', humanHours: Object.fromEntries(WEEKDAYS.map((d) => [d, ['00:00', '24:00'] as const])) });

const handoffScript = (text: string | null) => [
  { toolCalls: [{ toolName: 'ocso_request_handoff', input: { reason: 'refund above authority', summary: 'duplicate debit\nchecked ledger\napprove reversal', priority: 'P2' } }] },
  text === null ? { text: '' } : { text },
];

describe('handoff message and business hours', () => {
  it('inside human hours: the reply is unchanged and the conversation routes as before', async () => {
    await setHours(openNow());
    h.adapter.script = handoffScript('A colleague from the cards team will confirm here shortly.');
    const conversationId = await h.say('please reverse one of them');
    await h.processor('in-hours').processor.handle(turnMessage(conversationId));
    expect(await agentMessages(conversationId)).toEqual(['A colleague from the cards team will confirm here shortly.']);
    const [conv] = await h.t.db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conv).toMatchObject({ controlState: 'WAITING_FOR_HUMAN', queueId: h.queueId });
  });

  it('outside human hours: the reply says when the team is next available, in the agent time zone', async () => {
    const hours = closedNow();
    await setHours(hours);
    h.adapter.script = handoffScript('A colleague from the cards team will confirm this');
    const conversationId = await h.say('please reverse one of them');
    const when = formatOpening(nextOpening(hours, new Date())!, 'Asia/Kolkata');
    await h.processor('after-hours').processor.handle(turnMessage(conversationId));
    expect(await agentMessages(conversationId)).toEqual([`A colleague from the cards team will confirm this. Our team is next available ${when} and will reply here then.`]);
    expect(when).toMatch(/^\w+day \d{1,2} \w{3}, 09:00 GMT\+5:30$/);
    // Still routed to the queue (visible for pickup); an OPEN_PICKUP queue without auto-assign never auto-offers.
    const [conv] = await h.t.db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conv).toMatchObject({ controlState: 'WAITING_FOR_HUMAN', queueId: h.queueId, assignedUserId: null });
    const [handoff] = await h.t.db.select().from(handoffs).where(eq(handoffs.conversationId, conversationId));
    expect(handoff).toMatchObject({ status: 'WAITING', autoAssignAt: null });
  });

  it('outside human hours without model text: the default says a colleague will reply when the team is next available', async () => {
    const hours = closedNow();
    await setHours(hours);
    h.adapter.script = handoffScript(null);
    const conversationId = await h.say('I want to talk to a person');
    const when = formatOpening(nextOpening(hours, new Date())!, 'Asia/Kolkata');
    await h.processor('after-hours-default').processor.handle(turnMessage(conversationId));
    expect(await agentMessages(conversationId)).toEqual([`I've asked a colleague to help with this. Our team is next available ${when} and will reply here then.`]);
  });

  it('composes the text purely from hours and time', () => {
    const hours: BusinessHoursLike = { timezone: 'Asia/Kolkata', humanHours: { mon: ['08:00', '23:00'] } };
    const sunday = new Date('2026-09-27T12:00:00Z');
    expect(handoffMessage(null, { timezone: 'UTC', humanHours: {} }, sunday)).toBe(DEFAULT_HANDOFF_MESSAGE);
    expect(handoffMessage('Connecting you now!', null, sunday)).toBe('Connecting you now!');
    expect(handoffMessage(null, hours, sunday)).toBe("I've asked a colleague to help with this. Our team is next available Monday 28 Sep, 08:00 GMT+5:30 and will reply here then.");
    expect(handoffMessage('Connecting you now!', hours, sunday)).toBe('Connecting you now! Our team is next available Monday 28 Sep, 08:00 GMT+5:30 and will reply here then.');
    expect(handoffMessage('Handing over', hours, new Date('2026-09-28T03:00:00Z'))).toBe('Handing over');
  });
});
