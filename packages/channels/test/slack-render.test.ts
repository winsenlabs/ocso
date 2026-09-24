import { choicesPart, type InteractionPart } from '@ocso/domain';
import { describe, expect, it } from 'vitest';
import { createSlackChannelAdapter, SLACK_CAPABILITIES, toSlackMrkdwn } from '../src/index.js';
import { blockActionsBody, NOW, slackRequest, slConfig } from './helpers/slack.js';

const adapter = createSlackChannelAdapter({ now: () => NOW });
const render = (parts: InteractionPart[]) => adapter.render(parts, slConfig());

describe('Slack mrkdwn', () => {
  it('converts Markdown emphasis, links, headings, lists and rules', () => {
    expect(toSlackMrkdwn('**Bold** and *italic* and ~~gone~~')).toBe('*Bold* and _italic_ and ~gone~');
    expect(toSlackMrkdwn('See [the policy](https://bank.example/p?a=1&b=2).')).toBe('See <https://bank.example/p?a=1&amp;b=2|the policy>.');
    expect(toSlackMrkdwn('# Your card\n\n- one\n- two\n\n---\n\nend')).toBe('*Your card*\n\n• one\n• two\n\nend');
    expect(toSlackMrkdwn('> quoted **text**')).toBe('> quoted *text*');
  });

  it('escapes Slack’s control characters outside code and keeps code as is', () => {
    expect(toSlackMrkdwn('a < b & c > d <!channel>')).toBe('a &lt; b &amp; c &gt; d &lt;!channel&gt;');
  });

  it('never turns a Markdown link into a Slack mention or broadcast', () => {
    expect(toSlackMrkdwn('[x](!channel)')).toBe('x (!channel)');
    expect(toSlackMrkdwn('[team](<!channel>)')).toBe('team (!channel)');
    expect(toSlackMrkdwn('[hi](!here) ![x](!everyone)')).toBe('hi (!here) x (!everyone)');
    expect(toSlackMrkdwn('[boss](@U0123ABCD) [room](#C0123ABCD) [grp](<!subteam^S123>)')).toBe('boss (@U0123ABCD) room (#C0123ABCD) grp (!subteam^S123)');
    expect(toSlackMrkdwn('[x](javascript:alert(1))')).not.toContain('<');
    expect(toSlackMrkdwn('[mail](mailto:help@bank.example)')).toBe('<mailto:help@bank.example|mail>');
    for (const out of [toSlackMrkdwn('[a](!channel) [b](@U1) [c](!subteam^S1)')]) expect(out).not.toMatch(/<[!@#]/);
  });

  it('keeps code verbatim', () => {
    expect(toSlackMrkdwn('run `a_b*c` then\n```\nx **y** <z>\n```')).toBe('run `a_b*c` then\n```\nx **y** &lt;z&gt;\n```');
  });

  it('turns tables into readable rows', () => {
    expect(toSlackMrkdwn('| Fee | Amount |\n|---|---|\n| Late | 10 |')).toBe('*Fee | Amount*\nLate | 10');
  });
});

describe('Slack render', () => {
  it('renders text as mrkdwn, chunked at 40,000 characters', () => {
    expect(render([{ type: 'TEXT', text: 'Hello **there**' }])).toEqual([{ kind: 'SLACK', payload: { type: 'text', text: 'Hello *there*' }, partIndexes: [0] }]);
    const long = render([{ type: 'TEXT', text: 'word '.repeat(10_000) }]);
    expect(long.length).toBe(2);
    for (const r of long) expect(String((r.payload as { text: string }).text).length).toBeLessThanOrEqual(40_000);
  });

  it('renders choices as a Block Kit section and buttons whose action_id carries the option id', () => {
    const [out] = render([choicesPart({ text: 'Which **product**?', options: [{ id: 'cards', label: 'Cards' }, { id: 'loans', label: 'Loans' }] })]);
    expect(out).toEqual({
      kind: 'SLACK',
      partIndexes: [0],
      payload: {
        type: 'blocks',
        text: 'Which *product*?\n\n1. Cards\n2. Loans',
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: 'Which *product*?' } },
          {
            type: 'actions',
            block_id: 'ocso.choices',
            elements: [
              { type: 'button', action_id: 'ocso.choice:cards', value: 'cards', text: { type: 'plain_text', text: 'Cards', emoji: true } },
              { type: 'button', action_id: 'ocso.choice:loans', value: 'loans', text: { type: 'plain_text', text: 'Loans', emoji: true } },
            ],
          },
        ],
      },
    });
  });

  it('falls back to numbered text when buttons would be ambiguous', () => {
    const [out] = render([choicesPart({ text: 'Pick', options: [{ id: 'a', label: 'Same' }, { id: 'b', label: 'same' }] })]);
    expect(out?.payload).toEqual({ type: 'text', text: 'Pick\n\n1. Same\n2. same' });
  });

  it('sends other STRUCTURED parts as their fallback text and drops tool results', () => {
    const parts: InteractionPart[] = [
      { type: 'STRUCTURED', schema: 'order.summary', data: { id: 1 }, fallbackText: 'Order **42** shipped' },
      { type: 'TOOL_RESULT', toolCallId: 'c', toolName: 't', status: 'SUCCEEDED', summary: {} },
    ];
    expect(render(parts)).toEqual([{ kind: 'SLACK', payload: { type: 'text', text: 'Order *42* shipped' }, partIndexes: [0] }]);
  });

  it('declares text and buttons, no media, no receipts, 40,000 characters', () => {
    expect(SLACK_CAPABILITIES).toMatchObject({ maxTextLength: 40_000, interactive: true, deliveryReceipts: false, choices: { buttons: 25, list: 0 }, sessionWindowHours: null });
    expect(Object.values(SLACK_CAPABILITIES.allowedMimeTypes).flat()).toEqual([]);
  });
});

describe('Slack choice round trip', () => {
  it('a tap on a rendered button comes back as the option’s id and label', () => {
    const [out] = render([choicesPart({ text: 'Which product?', options: [{ id: 'ocso:step:v2', label: 'Home loans' }] })]);
    const blocks = (out?.payload as { blocks: Array<{ elements?: Array<Record<string, unknown>> }> }).blocks;
    const button = blocks[1]?.elements?.[0] ?? {};
    const envelope = adapter.parseInbound(slackRequest(blockActionsBody({ action_id: button['action_id'], value: button['value'], text: button['text'] })), slConfig());
    expect(envelope.messages[0]?.parts).toEqual([{ type: 'STRUCTURED', schema: 'button_reply', data: { id: 'ocso:step:v2', title: 'Home loans', source: 'slack' }, fallbackText: 'Home loans' }]);
  });
});
