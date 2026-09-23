import { describe, expect, it } from 'vitest';
import { RouterDefinitionSchema, type RouterDefinition } from '@ocso/domain';
import {
  attributeValues,
  definitionIssues,
  formatWhen,
  newStep,
  parseWhen,
  rulesFromQueues,
  slug,
  stepAttributes,
  templateName,
  uniqueStepId,
  unreachableRules,
  withTemplate,
} from '../../../components/routers/lib/definition';
import { parseAttributes, parseQueueForm } from '../../../components/queues/forms';

const TAMIL = '01a0cd12-87fc-71e6-85ff-7b598bcdf901';
const ENGLISH = '01a0cd12-87fc-71e6-85ff-7b598bcdf902';
const SALES = '01a0cd12-87fc-71e6-85ff-7b598bcdf903';
const CHANNEL = '01a0cd12-87fc-71e6-85ff-7b598bcdf904';
const TEMPLATE = '01a0cd12-87fc-71e6-85ff-7b598bcdf905';

const language = (): RouterDefinition => ({ steps: [newStep('ASK', [])], rules: [{ when: { language: 'ta' }, queueId: TAMIL }], fallbackQueueId: ENGLISH, returning: null, timeoutMinutes: 10 });

describe('router definition model (builder)', () => {
  it('new steps of every kind pass the schema once filled in, with unique ids', () => {
    const ask = newStep('ASK', []);
    const known = newStep('KNOWN', [ask]);
    const classify = newStep('CLASSIFY', [ask, known], SALES);
    const def = { ...language(), steps: [ask, known, classify] };
    expect(RouterDefinitionSchema.safeParse(def).success).toBe(true);
    expect(uniqueStepId('ask', [ask])).toBe('ask_2');
    // A classifier without a model profile is reported before saving.
    expect(definitionIssues({ ...def, steps: [ask, newStep('CLASSIFY', [ask])] }).map((i) => i.path)).toContain('steps.1.modelProfileId');
  });

  it('round-trips through JSON exactly (what the draft endpoint stores)', () => {
    const def: RouterDefinition = {
      ...language(),
      rules: [
        { when: { language: 'ta', product: ['sales', 'loans'] }, queueId: SALES },
        { when: { language: 'ta' }, queueId: TAMIL },
      ],
      returning: { askAfter: { value: 3, unit: 'DAYS' }, prompt: { text: 'Back again?', templates: { [CHANNEL]: TEMPLATE } }, continueLabel: 'Continue', newLabel: 'New' },
    };
    const parsed = RouterDefinitionSchema.parse(JSON.parse(JSON.stringify(def)));
    expect(parsed).toEqual(def);
    expect(definitionIssues(parsed)).toEqual([]);
  });

  it('rule conditions: text ⇄ when, with any-of values and clear errors', () => {
    const when = { language: 'ta', product: ['sales', 'loans'] };
    expect(formatWhen(when)).toBe('language=ta, product=sales|loans');
    expect(parseWhen('language=ta, product=sales|loans')).toEqual({ ok: true, when });
    expect(parseWhen('')).toEqual({ ok: true, when: {} });
    expect(parseWhen('language')).toMatchObject({ ok: false, message: expect.stringContaining('attribute=value') });
    expect(parseWhen('Language=ta')).toMatchObject({ ok: false });
    expect(parseWhen('language=ta, language=en')).toMatchObject({ ok: false, message: 'language appears twice' });
    expect(parseWhen('language=')).toMatchObject({ ok: false });
  });

  it('writes one rule per attribute queue the steps can reach, most specific first', () => {
    const def = language();
    const queues = [
      { id: ENGLISH, name: 'English', attributes: { language: 'en' } },
      { id: TAMIL, name: 'Tamil', attributes: { language: 'ta' } },
      { id: SALES, name: 'Tamil Sales', attributes: { language: 'ta', product: 'sales' } },
      { id: CHANNEL, name: 'Everything else', attributes: {} },
    ];
    // product is not set by any step yet: only the language queues.
    expect(rulesFromQueues(def, queues)).toEqual([
      { when: { language: 'en' }, queueId: ENGLISH },
      { when: { language: 'ta' }, queueId: TAMIL },
    ]);
    const withProduct = { ...def, steps: [...def.steps, { ...newStep('KNOWN', def.steps), attribute: 'product' }] };
    expect(rulesFromQueues(withProduct, queues)[0]).toEqual({ when: { language: 'ta', product: 'sales' }, queueId: SALES });
    expect(stepAttributes(withProduct)).toEqual(['language', 'product']);
    expect(attributeValues(def, 'language')).toEqual(['en', 'ta']);
    expect(unreachableRules({ ...def, rules: [{ when: { product: 'sales' }, queueId: SALES }] })).toEqual([0]);
  });

  it('maps and clears a per-channel template on a message', () => {
    const spec = { text: 'Which language?' };
    const mapped = withTemplate(spec, CHANNEL, TEMPLATE);
    expect(mapped).toEqual({ text: 'Which language?', templates: { [CHANNEL]: TEMPLATE } });
    expect(withTemplate(mapped, CHANNEL, null)).toEqual({ text: 'Which language?' });
    expect(templateName('Web chat — Language menu', 'ask_2')).toBe('web_chat_language_menu_ask_2');
    expect(slug('தமிழ்', 'ta')).toBe('ta');
  });
});

describe('queue dialog (attributes, agent, hours, transfer targets)', () => {
  it('parses attribute rows: lower-cased values, blank rows skipped, bad keys and duplicates refused', () => {
    expect(parseAttributes([{ key: 'language', value: 'TA' }, { key: '', value: '' }])).toEqual({ ok: true, data: { language: 'ta' } });
    expect(parseAttributes([{ key: 'Lang', value: 'ta' }])).toMatchObject({ ok: false });
    expect(parseAttributes([{ key: 'language', value: 'ta' }, { key: 'language', value: 'en' }])).toMatchObject({ ok: false, message: 'language is listed twice' });
    expect(parseAttributes([{ key: 'language', value: '' }])).toMatchObject({ ok: false, message: 'Give language a value' });
  });

  it('carries the routing fields into the request', () => {
    const r = parseQueueForm({
      name: 'Tamil',
      description: '',
      mode: 'OPEN_PICKUP',
      autoAssignAfterSeconds: '',
      acceptTimeoutSeconds: '',
      requiredSkills: '',
      languages: 'ta',
      preferAccountOwner: true,
      slaPolicyId: '',
      teamIds: [],
      agentId: TAMIL,
      attributes: [{ key: 'language', value: 'ta' }],
      businessHours: { timezone: 'Asia/Kolkata', humanHours: { mon: ['09:00', '18:00'] } },
      transferTargetIds: [ENGLISH],
    });
    expect(r).toMatchObject({ ok: true, data: { agentId: TAMIL, attributes: { language: 'ta' }, businessHours: { timezone: 'Asia/Kolkata' }, transferTargetIds: [ENGLISH] } });
    const bad = parseQueueForm({ name: 'x', description: '', mode: 'OPEN_PICKUP', autoAssignAfterSeconds: '', acceptTimeoutSeconds: '', requiredSkills: '', languages: '', preferAccountOwner: false, slaPolicyId: '', teamIds: [], attributes: [{ key: '9x', value: 'a' }] });
    expect(bad).toMatchObject({ ok: false, fieldErrors: { attributes: expect.any(String) } });
  });
});
