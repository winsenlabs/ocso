import { describe, expect, it } from 'vitest';
import { parseAttributes, parseCustomerForm, attributeText } from '../../../components/customers/forms';
import { parseCorrectionForm, parseReviewForm, rubricPreview } from '../../../components/quality/forms';
import { parseQueueForm, parseSlaForm, splitList, toHours, toMinutes, type QueueFormFields } from '../../../components/queues/forms';

const TEAM = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
const POLICY = '0192f3a4-5b6c-7d8e-9f01-23456789abce';
const CONV = '0192f3a4-5b6c-7d8e-9f01-23456789abcf';

const queue = (over: Partial<QueueFormFields> = {}): QueueFormFields => ({
  name: 'Cards & EMI · Tier 2',
  description: '',
  mode: 'OPEN_PICKUP',
  autoAssignAfterSeconds: '90',
  acceptTimeoutSeconds: '',
  requiredSkills: 'cards, emi,, cards',
  languages: 'en, hi',
  preferAccountOwner: true,
  slaPolicyId: POLICY,
  teamIds: [TEAM],
  ...over,
});

describe('queue form → QueueInput', () => {
  it('parses lists, blanks and defaults', () => {
    const r = parseQueueForm(queue());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({
      name: 'Cards & EMI · Tier 2',
      description: null,
      mode: 'OPEN_PICKUP',
      autoAssignAfterSeconds: 90,
      acceptTimeoutSeconds: 120,
      requiredSkills: ['cards', 'emi'],
      languages: ['en', 'hi'],
      preferAccountOwner: true,
      slaPolicyId: POLICY,
      teamIds: [TEAM],
    });
    expect(splitList(' a ,b,,a ')).toEqual(['a', 'b']);
  });

  it('drops the pickup auto-assign delay for auto-assign queues and allows no SLA policy', () => {
    const r = parseQueueForm(queue({ mode: 'AUTO_ASSIGN', acceptTimeoutSeconds: '60', slaPolicyId: '' }));
    expect(r.ok && r.data.autoAssignAfterSeconds).toBeNull();
    expect(r.ok && r.data.acceptTimeoutSeconds).toBe(60);
    expect(r.ok && r.data.slaPolicyId).toBeNull();
  });

  it('reports field errors the API would reject', () => {
    const r = parseQueueForm(queue({ name: ' ', autoAssignAfterSeconds: '5', mode: 'ROUND_ROBIN', teamIds: ['x'] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.fieldErrors).sort()).toEqual(['autoAssignAfterSeconds', 'mode', 'name', 'teamIds']);
  });
});

describe('SLA form → SlaPolicyInput (minutes and hours in, seconds out)', () => {
  it('converts targets and keeps blanks out', () => {
    const r = parseSlaForm({ name: 'Standard', firstHumanResponse: '15', pickup: { P1: '5', P2: '' }, resolution: { SUPPORT: '4', SALES: '0.5' }, atRiskPercent: '80' });
    expect(r).toEqual({
      ok: true,
      data: { name: 'Standard', firstHumanResponseSeconds: 900, pickupSecondsByPriority: { P1: 300 }, resolutionSecondsByType: { SUPPORT: 14_400, SALES: 1_800 }, atRiskFraction: 0.8 },
    });
  });

  it('defaults at-risk to 75% and validates ranges', () => {
    const ok = parseSlaForm({ name: 'x', firstHumanResponse: '0.5', pickup: {}, resolution: {}, atRiskPercent: '' });
    expect(ok.ok && ok.data.atRiskFraction).toBe(0.75);
    expect(ok.ok && ok.data.firstHumanResponseSeconds).toBe(30);
    const bad = parseSlaForm({ name: '', firstHumanResponse: '0.1', pickup: { P3: 'abc' }, resolution: { CUSTOM: '800' }, atRiskPercent: '100' });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(Object.keys(bad.fieldErrors).sort()).toEqual(['atRiskPercent', 'firstHumanResponse', 'name', 'pickupP3', 'resolutionCUSTOM']);
  });

  it('prints stored seconds back as form units', () => {
    expect(toMinutes(900)).toBe('15');
    expect(toMinutes(30)).toBe('0.5');
    expect(toMinutes(undefined)).toBe('');
    expect(toHours(14_400)).toBe('4');
    expect(toHours(900)).toBe('0.25');
  });
});

describe('review form → ReviewInput', () => {
  it('builds the rubric and omits blank notes', () => {
    const r = parseReviewForm({ conversationId: CONV, accuracy: '5', policy: '4', tone: '4', resolution: '3', outcomeTag: ' good handoff ', notes: '' });
    expect(r).toEqual({ ok: true, data: { conversationId: CONV, rubric: { accuracy: 5, policy: 4, tone: 4, resolution: 3 }, outcomeTag: 'good handoff' } });
  });

  it('requires every criterion on the 1–5 scale and an outcome', () => {
    const r = parseReviewForm({ conversationId: CONV, accuracy: '6', policy: '', tone: '0', resolution: '3', outcomeTag: '' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.fieldErrors).sort()).toEqual(['accuracy', 'outcomeTag', 'policy', 'tone']);
  });

  it('previews the API score formula only when complete', () => {
    expect(rubricPreview({ accuracy: 5, policy: 4, tone: 4, resolution: 3 })).toBe(4);
    expect(rubricPreview({ accuracy: 5, policy: 4, tone: 5, resolution: 5 })).toBe(4.75);
    expect(rubricPreview({ accuracy: 5 })).toBeNull();
  });
});

describe('correction form → CorrectionInput', () => {
  it('accepts an agent-level correction and drops blank optionals', () => {
    const r = parseCorrectionForm({ agentId: TEAM, conversationId: '', interactionSeq: '', title: '', observed: 'Asked for a statement', desired: 'Check the ledger first', componentKey: 'behavior', proposedText: '' });
    expect(r).toEqual({ ok: true, data: { agentId: TEAM, observed: 'Asked for a statement', desired: 'Check the ledger first', componentKey: 'behavior' } });
  });

  it('accepts a conversation turn without an agent', () => {
    const r = parseCorrectionForm({ conversationId: CONV, interactionSeq: '4', observed: 'abc', desired: 'def', componentKey: 'policies' });
    expect(r.ok && r.data.interactionSeq).toBe(4);
  });

  it('needs an agent or a conversation, a component, and a conversation for a turn', () => {
    const r = parseCorrectionForm({ interactionSeq: '2', observed: 'x', desired: 'def', componentKey: 'nope' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.fieldErrors['observed']).toBeDefined();
    expect(r.fieldErrors['componentKey']).toBeDefined();
    const noAgent = parseCorrectionForm({ interactionSeq: '2', observed: 'abc', desired: 'def', componentKey: 'behavior' });
    expect(noAgent.ok).toBe(false);
    if (noAgent.ok) return;
    expect(noAgent.fieldErrors['agentId']).toBe('Choose a virtual agent');
    expect(noAgent.fieldErrors['interactionSeq']).toBe('A turn needs a source conversation');
  });
});

describe('customer form → CustomerPatch', () => {
  it('parses attributes as a JSON object and blanks as null', () => {
    expect(parseCustomerForm({ displayName: ' Priya ', language: '', externalRef: 'CRM-1', attributes: '{"segment":"priority"}', accountOwnerUserId: '' })).toEqual({
      ok: true,
      data: { displayName: 'Priya', language: null, externalRef: 'CRM-1', attributes: { segment: 'priority' }, accountOwnerUserId: null },
    });
  });

  it('rejects non-object attributes and bad owners', () => {
    expect(parseAttributes('[1,2]').ok).toBe(false);
    expect(parseAttributes('{bad').ok).toBe(false);
    expect(parseAttributes('  ')).toEqual({ ok: true, value: {} });
    const r = parseCustomerForm({ displayName: 'x'.repeat(201), attributes: '"text"', accountOwnerUserId: 'me' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.fieldErrors).sort()).toEqual(['accountOwnerUserId', 'attributes', 'displayName']);
  });

  it('prints attribute values', () => {
    expect(attributeText('priority')).toBe('priority');
    expect(attributeText({ tier: 2 })).toBe('{"tier":2}');
    expect(attributeText(null)).toBe('—');
  });
});
