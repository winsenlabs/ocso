import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CapabilitiesAnswer, capabilitiesSummary, capabilitiesTable, introText, WRITES_OFF_LINE } from '../../../components/internal-agent/capabilities';
import { Composer, WHAT_CAN_YOU_DO } from '../../../components/internal-agent/composer';

vi.mock('../../../lib/actions/internal-agent', () => ({ confirmAskOcsoAction: vi.fn(), rejectAskOcsoAction: vi.fn() }));

const areas = [
  { area: 'agents', label: 'Virtual agents', reads: 5, writes: 4 },
  { area: 'insight', label: 'Insights', reads: 9, writes: 0 },
];

describe('"What can you do?" from the catalog', () => {
  it('summarises what the role reaches and that changes wait on a card', () => {
    expect(capabilitiesSummary(areas)).toBe(
      'With your permissions I can use 18 OCSO tools across 2 areas. Questions are answered straight away from live data. A change waits for your click on a card, and a change that needs a second person goes to a checker you choose.',
    );
    expect(capabilitiesSummary([{ area: 'insight', label: 'Insights', reads: 1, writes: 0 }])).toBe('With your permissions I can use 1 OCSO tool across 1 area. Your role lets me look things up, not change them.');
    expect(capabilitiesTable(areas)).toEqual({ columns: ['Area', 'Look up', 'Change'], rows: [['Virtual agents', 5, 4], ['Insights', 9, 0]] });
  });

  it('with the writes kill switch off, offers reads only and says changes are turned off by the deployment settings', () => {
    const summary = capabilitiesSummary(areas, false);
    expect(summary).toBe(`With your permissions I can use 14 OCSO tools across 2 areas. Questions are answered straight away from live data. ${WRITES_OFF_LINE}`);
    expect(summary).toContain('turned off by the deployment settings');
    expect(summary).not.toMatch(/waits for your click|checker/);
    expect(capabilitiesTable(areas, false)).toEqual({ columns: ['Area', 'Look up'], rows: [['Virtual agents', 5], ['Insights', 9]] });
    expect(capabilitiesTable([{ area: 'webhooks', label: 'Webhooks', reads: 0, writes: 2 }], false).rows).toEqual([]);
    const html = renderToStaticMarkup(createElement(CapabilitiesAnswer, { areas, writesOn: false }));
    expect(html).not.toContain('columnheader" class="n">Change');
    expect(introText(true)).toContain('ask it to make a change');
    expect(introText(false)).not.toMatch(/make a change|waits for you on a card|checker/);
    expect(introText(false)).toContain('turned off by the deployment settings');
  });

  it('renders as an answer, not a card', () => {
    const html = renderToStaticMarkup(createElement(CapabilitiesAnswer, { areas }));
    expect(html).toContain('role="note" aria-label="What Ask OCSO can do for you"');
    expect(html).not.toContain('role="group"');
    expect(html).toContain('<span role="cell">Virtual agents</span><span role="cell" class="n">5</span><span role="cell" class="n">4</span>');
  });

  it('the composer always offers "What can you do?" first', () => {
    const html = renderToStaticMarkup(
      createElement(Composer, {
        id: 'ia',
        inputRef: { current: null },
        roleChip: 'Head',
        suggestions: [{ label: 'Who is on my team?', prompt: 'Who is on my team?' }],
        disabled: false,
        working: false,
        attachContext: true,
        contextLabel: 'Home',
        onToggleContext: () => {},
        onSend: () => {},
        onStop: () => {},
        onWhatCanYouDo: () => {},
      }),
    );
    expect(html.indexOf(`>${WHAT_CAN_YOU_DO.label}</button>`)).toBeLessThan(html.indexOf('>Who is on my team?</button>'));
  });
});
