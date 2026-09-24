import type { InteractionPart } from '@ocso/domain';
import type { ChannelCapabilities, RenderedOutbound } from '../contract/types.js';
import { choicesPart, choicesPresentation, renderChoicesAsText } from '../contract/choices.js';
import { chunkText } from '../common/chunk.js';
import { truncateWithEllipsis } from '../common/text.js';

/**
 * Customer-safe parts → Bot Framework message payloads. Text goes as Teams
 * markdown (`textFormat: markdown`; headings become bold lines, the rest of
 * OCSO's basic markdown — emphasis, lists, links, code — Teams shows as is),
 * split at TEAMS_TEXT_LIMIT. A CHOICES question becomes an Adaptive Card:
 * up to 6 options as `Action.Submit` buttons, up to 10 as a drop-down with a
 * Send button. A tap posts `{ ocso: 'choice', id, label }` back as the
 * activity's `value` (see inbound.ts). Other STRUCTURED parts send their
 * fallback text.
 */

export const TEAMS_KIND = 'MS_TEAMS';
export const CHOICE_MARKER = 'choice';
export const CHOICE_INPUT_ID = 'ocsoChoice';
export const ADAPTIVE_CARD = 'application/vnd.microsoft.card.adaptive';
const BUTTON_TITLE_LIMIT = 60;

export type TeamsOutboundPayload = { type: 'text'; text: string } | { type: 'card'; card: Record<string, unknown>; summary: string };

const FENCE = /^\s*```/;

/** OCSO markdown → what Teams renders: ATX headings as bold lines (outside code blocks). */
export function toTeamsMarkdown(text: string): string {
  let inCode = false;
  return text
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) inCode = !inCode;
      if (inCode) return line;
      const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
      return heading ? `**${heading[1]}**` : line;
    })
    .join('\n');
}

export function choicesCard(question: string, options: ReadonlyArray<{ id: string; label: string }>, presentation: 'buttons' | 'list'): Record<string, unknown> {
  const body: Array<Record<string, unknown>> = [{ type: 'TextBlock', text: question, wrap: true }];
  let actions: Array<Record<string, unknown>>;
  if (presentation === 'buttons') {
    actions = options.map((o) => ({ type: 'Action.Submit', title: truncateWithEllipsis(o.label, BUTTON_TITLE_LIMIT), data: { ocso: CHOICE_MARKER, id: o.id, label: o.label } }));
  } else {
    body.push({
      type: 'Input.ChoiceSet',
      id: CHOICE_INPUT_ID,
      style: 'compact',
      isRequired: true,
      errorMessage: 'Choose an option',
      placeholder: 'Choose…',
      choices: options.map((o) => ({ title: o.label, value: o.id })),
    });
    actions = [{ type: 'Action.Submit', title: 'Send', data: { ocso: CHOICE_MARKER, labels: Object.fromEntries(options.map((o) => [o.id, o.label])) } }];
  }
  return { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4', body, actions };
}

const rendered = (payload: TeamsOutboundPayload, index: number): RenderedOutbound => ({ kind: TEAMS_KIND, payload, partIndexes: [index] });

function textPayloads(text: string, index: number, capabilities: ChannelCapabilities): RenderedOutbound[] {
  return chunkText(toTeamsMarkdown(text), capabilities.maxTextLength).map((chunk) => rendered({ type: 'text', text: chunk }, index));
}

export function renderTeamsParts(parts: readonly InteractionPart[], capabilities: ChannelCapabilities): RenderedOutbound[] {
  return parts.flatMap((part, index): RenderedOutbound[] => {
    if (part.type === 'TEXT') return part.text.trim() ? textPayloads(part.text, index, capabilities) : [];
    if (part.type !== 'STRUCTURED') return [];
    const choices = choicesPart(part);
    if (choices) {
      const presentation = choicesPresentation(choices, capabilities);
      if (presentation === 'text') return textPayloads(renderChoicesAsText(choices), index, capabilities);
      return [rendered({ type: 'card', card: choicesCard(choices.text, choices.options, presentation), summary: truncateWithEllipsis(choices.text, 200) }, index)];
    }
    return part.fallbackText?.trim() ? textPayloads(part.fallbackText, index, capabilities) : [];
  });
}
