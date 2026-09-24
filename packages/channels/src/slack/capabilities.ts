import type { ChannelCapabilities } from '../contract/types.js';

/**
 * Slack (Events API in, Web API `chat.postMessage` out). v1 is text only:
 * files customers share are not imported and OCSO sends no files (Slack's
 * upload flow needs `files:write` and a separate two-step API). CHOICES go
 * out as Block Kit buttons and come back as STRUCTURED replies. Slack has no
 * delivery receipts and no customer-service window.
 */

export const SLACK_IDENTITY = 'slack_user';

/** `chat.postMessage` truncates `text` beyond 40,000 characters. */
export const SLACK_TEXT_LIMIT = 40_000;
/** A section block's mrkdwn text. */
export const SLACK_SECTION_TEXT_LIMIT = 3_000;
/** Elements in one `actions` block. */
export const SLACK_MAX_BUTTONS = 25;
/** Button `text` (plain_text). */
export const SLACK_BUTTON_TEXT_LIMIT = 75;
/** `action_id` and `value` of a button. */
export const SLACK_ACTION_ID_LIMIT = 255;

const none = { IMAGE: 0, AUDIO: 0, VIDEO: 0, DOCUMENT: 0 } as const;

export const SLACK_CAPABILITIES: ChannelCapabilities = Object.freeze<ChannelCapabilities>({
  inboundParts: ['TEXT', 'STRUCTURED'],
  outboundParts: ['TEXT', 'STRUCTURED'],
  maxTextLength: SLACK_TEXT_LIMIT,
  markdown: 'basic',
  streaming: false,
  deliveryReceipts: false,
  interactive: true,
  maxMediaBytes: none,
  allowedMimeTypes: { IMAGE: [], AUDIO: [], VIDEO: [], DOCUMENT: [] },
  sessionWindowHours: null,
  identityKinds: [SLACK_IDENTITY],
  choices: { buttons: SLACK_MAX_BUTTONS, list: 0 },
});
