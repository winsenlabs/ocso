import { describe, expect, it } from 'vitest';
import {
  RouterDefinitionSchema,
  advanceSession,
  choicesPart,
  choicesText,
  evaluateRules,
  isPassThrough,
  matchOption,
  matchReturning,
  newSession,
  returningDue,
  routerReferences,
  routerReplyOf,
  transition,
  type RouterDefinition,
  type RoutingSession,
  type SessionContext,
} from '../src/index.js';

const Q = { cards: '00000000-0000-7000-8000-00000000000c', sales: '00000000-0000-7000-8000-00000000000d', profile: '00000000-0000-7000-8000-00000000000e' };
const ASK = {
  id: 'product',
  kind: 'ASK' as const,
  attribute: 'product',
  prompt: { text: 'Which?' },
  options: [
    { value: 'cards', label: 'Cards & EMI', synonyms: ['card', 'emi'] },
    { value: 'sales', label: 'Loans', synonyms: ['loan'] },
  ],
  maxAttempts: 2,
  skipIfKnown: true,
};
const MENU: RouterDefinition = { steps: [ASK], rules: [{ when: { product: 'sales' }, queueId: Q.sales }], fallbackQueueId: Q.cards, returning: null, timeoutMinutes: 10 };
const none: SessionContext = { known: () => null };
const reply = (text: string, choiceIds: string[] = []) => ({ type: 'REPLY' as const, reply: { text, choiceIds } });

describe('router definition', () => {
  it('accepts a pass-through and a menu; rejects bad keys, duplicate options and equal returning labels', () => {
    expect(RouterDefinitionSchema.safeParse({ steps: [], rules: [], fallbackQueueId: Q.cards, returning: null, timeoutMinutes: 10 }).success).toBe(true);
    expect(RouterDefinitionSchema.safeParse(MENU).success).toBe(true);
    const messages = (def: unknown) => RouterDefinitionSchema.safeParse(def).error?.issues.map((i) => i.message) ?? [];
    expect(messages({ ...MENU, steps: [{ ...ASK, attribute: 'Product' }] })[0]).toContain('lower snake case');
    expect(messages({ ...MENU, steps: [{ ...ASK, options: [{ value: 'a', label: 'A' }, { value: 'A ', label: 'B' }] }] })).toContain('option values must be unique within a step');
    expect(messages({ ...MENU, steps: [ASK, ASK] })).toContain('step id product is used twice');
    expect(messages({ ...MENU, returning: { askAfter: { value: 1, unit: 'DAYS' }, prompt: { text: 'Back?' }, continueLabel: 'Go', newLabel: 'go' } })).toContain('the continue and new labels must differ');
    expect(messages({ ...MENU, steps: [{ ...ASK, options: [ASK.options[0]] }] }).length).toBeGreaterThan(0);
    expect(messages({ ...MENU, timeoutMinutes: 0 }).length).toBeGreaterThan(0);
  });

  it('knows what it references and whether it is pass-through', () => {
    expect(isPassThrough(MENU)).toBe(false);
    expect(isPassThrough({ ...MENU, steps: [] })).toBe(true);
    const def: RouterDefinition = {
      ...MENU,
      steps: [{ ...ASK, prompt: { text: 'x', templates: { [Q.sales]: Q.profile } } }, { id: 'c', kind: 'CLASSIFY', attribute: 'topic', modelProfileId: Q.profile, instructions: '', labels: [{ value: 'a', description: '' }, { value: 'b', description: '' }], minConfidence: 0.7, maxFollowUps: 1, skipIfKnown: false }],
    };
    expect(routerReferences(def)).toEqual({ queueIds: [Q.cards, Q.sales], modelProfileIds: [Q.profile], templates: [{ channelId: Q.sales, templateId: Q.profile }] });
  });
});

describe('matching', () => {
  it('matches a tapped id, a number, a label, a synonym, or one option mentioned in a sentence', () => {
    const m = (text: string, ids: string[] = []) => matchOption('product', ASK.options, { text, choiceIds: ids })?.value ?? null;
    expect(m('', ['ocso:product:sales'])).toBe('sales');
    expect(m('2')).toBe('sales');
    expect(m(' 1. ')).toBe('cards');
    expect(m('3')).toBeNull();
    expect(m('LOANS!')).toBe('sales');
    expect(m('emi')).toBe('cards');
    expect(m('my card got blocked')).toBe('cards');
    expect(m('card or loan, not sure')).toBeNull();
    expect(m('hello')).toBeNull();
  });

  it('returning: continue or new by label, number or the plain words', () => {
    const r = { continueLabel: 'Continue', newLabel: 'Something new' };
    expect(matchReturning(r, { text: '1', choiceIds: [] })).toBe('continue');
    expect(matchReturning(r, { text: 'something new', choiceIds: [] })).toBe('new');
    expect(matchReturning(r, { text: 'new', choiceIds: [] })).toBe('new');
    expect(matchReturning(r, { text: '', choiceIds: ['ocso:returning:continue'] })).toBe('continue');
    expect(matchReturning(r, { text: 'maybe', choiceIds: [] })).toBeNull();
  });

  it('rules: every key must match, arrays match any value, first match wins, empty when matches all', () => {
    const rules = [
      { when: { language: ['ta', 'hi'], product: 'sales' }, queueId: 'a' },
      { when: { product: 'sales' }, queueId: 'b' },
      { when: {}, queueId: 'c' },
    ];
    expect(evaluateRules(rules, { language: 'TA', product: 'sales' })?.rule.queueId).toBe('a');
    expect(evaluateRules(rules, { product: 'sales' })?.index).toBe(1);
    expect(evaluateRules(rules, {})?.rule.queueId).toBe('c');
    expect(evaluateRules(rules.slice(0, 2), { language: 'en' })).toBeNull();
  });

  it('returning gap in hours, days and calendar months', () => {
    const last = new Date('2026-01-31T10:00:00Z');
    expect(returningDue({ value: 2, unit: 'HOURS' }, last, new Date('2026-01-31T11:59:00Z'))).toBe(false);
    expect(returningDue({ value: 2, unit: 'HOURS' }, last, new Date('2026-01-31T12:00:00Z'))).toBe(true);
    expect(returningDue({ value: 1, unit: 'DAYS' }, last, new Date('2026-02-01T10:00:00Z'))).toBe(true);
    expect(returningDue({ value: 1, unit: 'MONTHS' }, last, new Date('2026-03-02T09:00:00Z'))).toBe(false);
    expect(returningDue({ value: 1, unit: 'MONTHS' }, last, new Date('2026-03-03T10:00:00Z'))).toBe(true);
    expect(returningDue({ value: 1, unit: 'DAYS' }, null, new Date())).toBe(false);
  });
});

describe('choices', () => {
  it('a CHOICES part carries numbered fallback text; replies expose text and tapped ids', () => {
    const data = { text: 'Which?', options: [{ id: 'ocso:p:a', label: 'A' }, { id: 'ocso:p:b', label: 'B' }] };
    expect(choicesText(data)).toBe('Which?\n\n1. A\n2. B');
    expect(choicesPart(data)).toMatchObject({ type: 'STRUCTURED', schema: 'ocso.choices', fallbackText: 'Which?\n\n1. A\n2. B' });
    expect(routerReplyOf([{ type: 'STRUCTURED', schema: 'button_reply', data: { id: 'ocso:p:b', title: 'B' }, fallbackText: 'B' }])).toEqual({ text: 'B', choiceIds: ['ocso:p:b'] });
  });
});

describe('router session', () => {
  const run = (def: RouterDefinition, s: RoutingSession, ...events: Parameters<typeof advanceSession>[2][]) => {
    const actions: string[] = [];
    let session = s;
    for (const e of events) {
      const r = advanceSession(def, session, e, none);
      session = r.session;
      actions.push(...r.actions.map((a) => (a.type === 'DECIDE' ? `DECIDE:${a.outcome}:${a.queueId === Q.sales ? 'sales' : 'cards'}` : a.type === 'SEND' ? `SEND:${a.stepId}` : a.type)));
    }
    return { session, actions };
  };

  it('asks, re-asks, then leaves the attribute unset and falls back', () => {
    expect(run(MENU, newSession('STEPS'), { type: 'START' }, reply('2')).actions).toEqual(['SEND:product', 'DECIDE:RULE:sales']);
    const unclear = run(MENU, newSession('STEPS'), { type: 'START' }, reply('what'), reply('eh'));
    expect(unclear.actions).toEqual(['SEND:product', 'SEND:product', 'DECIDE:FALLBACK:cards']);
    expect(unclear.session.attributes).toEqual({});
  });

  it('does not mutate its input and ignores a START while it waits', () => {
    const start = newSession('STEPS');
    const asked = advanceSession(MENU, start, { type: 'START' }, none).session;
    expect(start.awaiting).toBe(false);
    expect(advanceSession(MENU, asked, { type: 'START' }, none).actions).toEqual([]);
  });

  it('KNOWN fills an attribute and skipIfKnown skips the question', () => {
    const def: RouterDefinition = { ...MENU, steps: [{ id: 'k', kind: 'KNOWN', attribute: 'product', from: 'customer.attribute:segment' }, ASK] };
    const r = advanceSession(def, newSession('STEPS'), { type: 'START' }, { known: (from) => (from === 'customer.attribute:segment' ? 'sales' : null) });
    expect(r.actions).toMatchObject([{ type: 'DECIDE', outcome: 'RULE', queueId: Q.sales }]);
  });

  it('CLASSIFY: commits above minConfidence, else asks the follow-up while allowed, else leaves it unset', () => {
    const def: RouterDefinition = {
      ...MENU,
      steps: [{ id: 'c', kind: 'CLASSIFY', attribute: 'product', modelProfileId: Q.profile, instructions: '', labels: [{ value: 'cards', description: '' }, { value: 'sales', description: '' }], minConfidence: 0.7, maxFollowUps: 1, skipIfKnown: false }],
    };
    const low = { type: 'CLASSIFIED' as const, stepId: 'c', result: { label: 'sales', confidence: 0.4, followUp: 'New or existing?' } };
    const high = { type: 'CLASSIFIED' as const, stepId: 'c', result: { label: 'SALES', confidence: 0.9, followUp: null } };
    expect(run(def, newSession('STEPS'), { type: 'START' }, low, reply('new'), high).actions).toEqual(['CLASSIFY', 'SEND:c', 'CLASSIFY', 'DECIDE:MODEL:sales']);
    expect(run(def, newSession('STEPS'), { type: 'START' }, low, reply('new'), low).actions).toEqual(['CLASSIFY', 'SEND:c', 'CLASSIFY', 'DECIDE:FALLBACK:cards']);
    // A label the step does not have is not a classification.
    expect(run(def, newSession('STEPS'), { type: 'START' }, { type: 'CLASSIFIED', stepId: 'c', result: { label: 'mortgage', confidence: 1, followUp: null } }).actions).toEqual(['CLASSIFY', 'DECIDE:FALLBACK:cards']);
    // A classifier failure is recorded as such (an outage is not low confidence) and falls back.
    const failed = run(def, newSession('STEPS'), { type: 'START' }, { type: 'CLASSIFIED', stepId: 'c', result: { label: null, confidence: 0, followUp: null, error: 'provider_down' } });
    expect(failed.actions).toEqual(['CLASSIFY', 'DECIDE:FALLBACK:cards']);
    expect(failed.session.classifications).toEqual({ c: { label: null, confidence: 0, error: 'provider_down' } });
  });

  it('TIMEOUT: steps fall back; the returning question continues', () => {
    expect(run(MENU, newSession('STEPS'), { type: 'START' }, { type: 'TIMEOUT' }).actions).toEqual(['SEND:product', 'DECIDE:TIMEOUT:cards']);
    const def = { ...MENU, returning: { askAfter: { value: 1, unit: 'DAYS' as const }, prompt: { text: 'Back?' }, continueLabel: 'Continue', newLabel: 'New' } };
    expect(run(def, newSession('RETURNING'), { type: 'START' }, { type: 'TIMEOUT' }).actions).toEqual(['SEND:returning', 'CONTINUE']);
    expect(run(def, newSession('RETURNING'), { type: 'START' }, reply('new')).actions).toEqual(['SEND:returning', 'NEW']);
    expect(run(def, newSession('RETURNING'), { type: 'START' }, reply('?'), reply('??')).actions).toEqual(['SEND:returning', 'SEND:returning', 'CONTINUE']);
  });
});

describe('routing control states', () => {
  it('ROUTE_START from AI_ACTIVE or RESOLVED; COMPLETE and CONTINUE by the system only; TRANSFER_QUEUE keeps the state', () => {
    expect(transition('AI_ACTIVE', 'ROUTE_START', { actor: 'SYSTEM' })).toBe('ROUTING');
    expect(transition('RESOLVED', 'ROUTE_START', { actor: 'SYSTEM' })).toBe('ROUTING');
    expect(() => transition('HUMAN_ACTIVE', 'ROUTE_START', { actor: 'SYSTEM' })).toThrow();
    expect(transition('ROUTING', 'ROUTE_COMPLETE', { actor: 'SYSTEM' })).toBe('AI_ACTIVE');
    expect(() => transition('ROUTING', 'ROUTE_COMPLETE', { actor: 'HUMAN', actorUserId: 'u' })).toThrow();
    expect(transition('ROUTING', 'ROUTE_CONTINUE', { actor: 'SYSTEM', restoreState: 'RESOLVED' })).toBe('AI_ACTIVE');
    expect(transition('ROUTING', 'RESOLVE', { actor: 'HUMAN', actorUserId: 'u' })).toBe('RESOLVED');
    expect(transition('AI_ACTIVE', 'TRANSFER_QUEUE', { actor: 'AGENT' })).toBe('AI_ACTIVE');
    expect(() => transition('WAITING_FOR_HUMAN', 'TRANSFER_QUEUE', { actor: 'AGENT' })).toThrow();
    expect(transition('WAITING_FOR_HUMAN', 'TRANSFER_QUEUE', { actor: 'HUMAN', actorUserId: 'u' })).toBe('WAITING_FOR_HUMAN');
    expect(() => transition('ROUTING', 'REQUEST_ESCALATION', { actor: 'AGENT' })).toThrow();
  });
});
