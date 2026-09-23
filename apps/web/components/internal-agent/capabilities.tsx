import { OcsoAvatar } from './turns';
import { MiniTable } from './parts';
import type { CapabilityArea, MiniTableData } from './types';

/**
 * The "What can you do?" answer from the capability catalog (PM/research/12 §7): what this user's role reaches,
 * per area, with no model call. Counts are the catalog tools the user's permissions cover; a change is still a card.
 */
/** Said wherever the drawer describes what it can do while the deployment's writes switch is off. */
export const WRITES_OFF_LINE = 'Changes through Ask OCSO are turned off by the deployment settings, so I can only look things up; make changes on their pages in OCSO.';

export function capabilitiesTable(areas: CapabilityArea[], writesOn = true): MiniTableData {
  if (!writesOn) return { columns: ['Area', 'Look up'], rows: areas.filter((a) => a.reads > 0).map((a) => [a.label, a.reads]) };
  return { columns: ['Area', 'Look up', 'Change'], rows: areas.map((a) => [a.label, a.reads, a.writes]) };
}

export function capabilitiesSummary(areas: CapabilityArea[], writesOn = true): string {
  const shown = writesOn ? areas : areas.filter((a) => a.reads > 0);
  const reads = shown.reduce((n, a) => n + a.reads, 0);
  const writes = writesOn ? shown.reduce((n, a) => n + a.writes, 0) : 0;
  const scope = `With your permissions I can use ${reads + writes} OCSO tool${reads + writes === 1 ? '' : 's'} across ${shown.length} area${shown.length === 1 ? '' : 's'}.`;
  const how = !writesOn
    ? `Questions are answered straight away from live data. ${WRITES_OFF_LINE}`
    : writes
      ? 'Questions are answered straight away from live data. A change waits for your click on a card, and a change that needs a second person goes to a checker you choose.'
      : 'Your role lets me look things up, not change them.';
  return `${scope} ${how}`;
}

/** The drawer's opening line: it promises changes only when the deployment allows them. */
export function introText(writesOn: boolean): string {
  return writesOn
    ? 'Ask about conversations, agents, queues or configuration, or ask it to make a change. OCSO works with exactly your permissions: reads answer straight away, and every change waits for you on a card. Changes that need a second person go to a checker you choose.'
    : `Ask about conversations, agents, queues or configuration. OCSO works with exactly your permissions and answers from live data. ${WRITES_OFF_LINE}`;
}

export function CapabilitiesAnswer({ areas, writesOn = true }: { areas: CapabilityArea[]; writesOn?: boolean }) {
  return (
    <div className="aturn ia-capabilities" role="note" aria-label="What Ask OCSO can do for you">
      <OcsoAvatar />
      <span className="bd">
        <span className="ans">{capabilitiesSummary(areas, writesOn)}</span>
        <MiniTable table={capabilitiesTable(areas, writesOn)} />
        <span className="mono-sm">Ask in your own words, for example “what is waiting on my approval?”</span>
      </span>
    </div>
  );
}
