import { describe, expect, it } from 'vitest';
import type { InteractionPart } from '@ocso/domain';
import { ADAPTIVE_CARD, createMsTeamsAdapter, TEAMS_CAPABILITIES, TEAMS_TEXT_LIMIT, toTeamsMarkdown } from '../src/index.js';
import { mtConfig } from './helpers/teams.js';

const adapter = createMsTeamsAdapter();
const render = (parts: InteractionPart[]) => adapter.render(parts, mtConfig());
const choices = (n: number, text = 'Which product?'): InteractionPart => ({
  type: 'STRUCTURED',
  schema: 'ocso.choices',
  data: { text, options: Array.from({ length: n }, (_, i) => ({ id: `opt${i + 1}`, label: `Option ${i + 1}` })) },
  fallbackText: text,
});

describe('Teams render', () => {
  it('sends text as Teams markdown with headings as bold lines (not inside code blocks)', () => {
    expect(toTeamsMarkdown('## Your card\nIt is **on its way**.\n```\n# not a heading\n```')).toBe('**Your card**\nIt is **on its way**.\n```\n# not a heading\n```');
    expect(render([{ type: 'TEXT', text: '# Hi\n- one\n- [link](https://x.example)' }])).toEqual([
      { kind: 'MS_TEAMS', payload: { type: 'text', text: '**Hi**\n- one\n- [link](https://x.example)' }, partIndexes: [0] },
    ]);
  });

  it('splits long text at the Teams limit and drops blank parts', () => {
    const long = 'word '.repeat(3_000).trim();
    const out = render([{ type: 'TEXT', text: '   ' }, { type: 'TEXT', text: long }]);
    expect(out.length).toBeGreaterThan(1);
    for (const r of out) {
      expect((r.payload as { text: string }).text.length).toBeLessThanOrEqual(TEAMS_TEXT_LIMIT);
      expect(r.partIndexes).toEqual([1]);
    }
  });

  it('renders up to 6 choices as an Adaptive Card with one Action.Submit per option', () => {
    const [out] = render([choices(2)]);
    expect(out?.payload).toEqual({
      type: 'card',
      summary: 'Which product?',
      card: {
        type: 'AdaptiveCard',
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.4',
        body: [{ type: 'TextBlock', text: 'Which product?', wrap: true }],
        actions: [
          { type: 'Action.Submit', title: 'Option 1', data: { ocso: 'choice', id: 'opt1', label: 'Option 1' } },
          { type: 'Action.Submit', title: 'Option 2', data: { ocso: 'choice', id: 'opt2', label: 'Option 2' } },
        ],
      },
    });
    expect(ADAPTIVE_CARD).toBe('application/vnd.microsoft.card.adaptive');
  });

  it('renders 7–10 choices as a drop-down with a Send button; an invalid question goes as its fallback text', () => {
    const [list] = render([choices(8)]);
    const card = (list?.payload as { card: { body: Array<Record<string, unknown>>; actions: Array<Record<string, unknown>> } }).card;
    expect(card.body[1]).toMatchObject({ type: 'Input.ChoiceSet', id: 'ocsoChoice', style: 'compact', isRequired: true });
    expect((card.body[1]!['choices'] as unknown[]).length).toBe(8);
    expect(card.actions).toEqual([{ type: 'Action.Submit', title: 'Send', data: { ocso: 'choice', labels: expect.objectContaining({ opt1: 'Option 1', opt8: 'Option 8' }) } }]);
    // More than 10 options is not a valid choice question (domain schema): its fallback text is sent.
    expect(render([choices(12)])[0]?.payload).toEqual({ type: 'text', text: 'Which product?' });
  });

  it('keeps a full 60-character label as the button title and in the data', () => {
    const label = 'L'.repeat(60);
    const [out] = render([{ type: 'STRUCTURED', schema: 'ocso.choices', data: { text: 'Pick', options: [{ id: 'a', label }] }, fallbackText: 'Pick' }]);
    const action = (out?.payload as { card: { actions: Array<{ title: string; data: { label: string } }> } }).card.actions[0]!;
    expect(action).toMatchObject({ title: label, data: { label } });
  });

  it('sends other STRUCTURED parts as their fallback text and skips media', () => {
    expect(render([{ type: 'STRUCTURED', schema: 'x.other', data: {}, fallbackText: 'Fallback' }])).toEqual([{ kind: 'MS_TEAMS', payload: { type: 'text', text: 'Fallback' }, partIndexes: [0] }]);
    expect(TEAMS_CAPABILITIES.outboundParts).toEqual(['TEXT', 'STRUCTURED']);
  });
});
