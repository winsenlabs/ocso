import { choicesOf, choicesText, type ChoicesData, type InteractionPart } from '@ocso/domain';
import type { ChannelCapabilities, RenderedOutbound } from '../contract/types.js';
import { choicesPresentation } from '../contract/choices.js';
import { customerSafeParts } from '../contract/render-policy.js';
import { chunkText } from '../common/chunk.js';
import { truncateWithEllipsis } from '../common/text.js';
import { SLACK_ACTION_ID_LIMIT, SLACK_BUTTON_TEXT_LIMIT, SLACK_SECTION_TEXT_LIMIT, SLACK_TEXT_LIMIT } from './capabilities.js';
import { toSlackMrkdwn } from './format.js';
import type { SlackOutboundPayload } from './payload.js';

/**
 * Canonical parts -> Slack payloads. TEXT becomes mrkdwn (chunked at the
 * 40,000-character `text` limit). CHOICES become Block Kit: a section with
 * the question and an actions block of buttons whose `action_id` is
 * `ocso.choice:<option id>` (and whose value is the option id), so a click
 * comes back as a STRUCTURED `button_reply` with that id. When buttons cannot
 * carry the options faithfully (ids too long, repeated ids or labels) the
 * numbered text form is sent instead and the customer answers by number or
 * label. Other STRUCTURED parts go out as their fallback text.
 */

type StructuredPart = Extract<InteractionPart, { type: 'STRUCTURED' }>;

/** `action_id` prefix of OCSO's choice buttons; the rest is the option id. */
export const SLACK_CHOICE_ACTION_PREFIX = 'ocso.choice:';
/** `block_id` of the actions block holding the choice buttons. */
export const SLACK_CHOICES_BLOCK_ID = 'ocso.choices';
/** Schema of the STRUCTURED part a button tap becomes (the same as WhatsApp, web chat and Teams button replies). */
export const SLACK_CHOICE_REPLY_SCHEMA = 'button_reply';
/** Longest option id a button can carry (`action_id` is at most 255 characters). */
const MAX_OPTION_ID = SLACK_ACTION_ID_LIMIT - SLACK_CHOICE_ACTION_PREFIX.length;

export function slackTextPayloads(markdown: string): SlackOutboundPayload[] {
  return chunkText(toSlackMrkdwn(markdown), SLACK_TEXT_LIMIT).map((text) => ({ type: 'text' as const, text }));
}

const distinct = (values: readonly string[]) => new Set(values.map((v) => v.toLowerCase())).size === values.length;

function buttonsFit(data: ChoicesData): boolean {
  const labels = data.options.map((o) => truncateWithEllipsis(o.label.trim(), SLACK_BUTTON_TEXT_LIMIT));
  const ids = data.options.map((o) => o.id);
  return labels.every(Boolean) && distinct(labels) && new Set(ids).size === ids.length && ids.every((id) => id.length > 0 && id.length <= MAX_OPTION_ID);
}

function choiceBlocks(data: ChoicesData): SlackOutboundPayload[] {
  const question = toSlackMrkdwn(data.text);
  const long = question.length > SLACK_SECTION_TEXT_LIMIT;
  const lead = long ? slackTextPayloads(data.text) : [];
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: long ? 'Choose an option:' : question || 'Choose an option:' } },
    {
      type: 'actions',
      block_id: SLACK_CHOICES_BLOCK_ID,
      elements: data.options.map((o) => ({
        type: 'button',
        action_id: `${SLACK_CHOICE_ACTION_PREFIX}${o.id}`,
        value: o.id,
        text: { type: 'plain_text', text: truncateWithEllipsis(o.label.trim(), SLACK_BUTTON_TEXT_LIMIT), emoji: true },
      })),
    },
  ];
  // `text` is what notifications and screen readers show; the numbered form reads well there.
  const text = truncateWithEllipsis(toSlackMrkdwn(choicesText(data)), SLACK_SECTION_TEXT_LIMIT);
  return [...lead, { type: 'blocks', text, blocks }];
}

function renderStructured(part: StructuredPart, capabilities: ChannelCapabilities): SlackOutboundPayload[] {
  const choices = choicesOf(part);
  if (choices) {
    return choicesPresentation(choices, capabilities) === 'buttons' && buttonsFit(choices) ? choiceBlocks(choices) : slackTextPayloads(choicesText(choices));
  }
  return part.fallbackText?.trim() ? slackTextPayloads(part.fallbackText) : [];
}

export function renderSlackParts(parts: readonly InteractionPart[], capabilities: ChannelCapabilities): RenderedOutbound[] {
  const safe = new Set(customerSafeParts(parts, capabilities).parts);
  const out: RenderedOutbound[] = [];
  parts.forEach((part, index) => {
    if (!safe.has(part)) return;
    const payloads = part.type === 'TEXT' ? slackTextPayloads(part.text) : part.type === 'STRUCTURED' ? renderStructured(part, capabilities) : [];
    for (const payload of payloads) out.push({ kind: 'SLACK', payload, partIndexes: [index] });
  });
  return out;
}
