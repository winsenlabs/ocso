import type { ChannelCapabilities } from '../contract/types.js';
import { TEAMS_IDENTITY } from './identity.js';

/**
 * Microsoft Teams bot capabilities (v1). Text and choice cards in both
 * directions; no media yet (files in Teams need the bot's file consent flow
 * or SharePoint links, so attachments are neither downloaded nor sent). A bot
 * message may be at most ~28 KB including the activity envelope, so text is
 * split at 7,000 characters (4 bytes each in the worst case). No delivery
 * receipts and no customer-service window.
 */

export const TEAMS_TEXT_LIMIT = 7_000;
/** Teams shows at most 6 top-level Adaptive Card actions; longer lists become a drop-down. */
export const TEAMS_MAX_CARD_BUTTONS = 6;
export const TEAMS_MAX_CHOICE_LIST = 10;

export const TEAMS_CAPABILITIES: ChannelCapabilities = Object.freeze<ChannelCapabilities>({
  inboundParts: ['TEXT', 'STRUCTURED'],
  outboundParts: ['TEXT', 'STRUCTURED'],
  maxTextLength: TEAMS_TEXT_LIMIT,
  markdown: 'basic',
  streaming: false,
  deliveryReceipts: false,
  interactive: true,
  maxMediaBytes: { IMAGE: 0, AUDIO: 0, VIDEO: 0, DOCUMENT: 0 },
  allowedMimeTypes: { IMAGE: [], AUDIO: [], VIDEO: [], DOCUMENT: [] },
  sessionWindowHours: null,
  identityKinds: [TEAMS_IDENTITY.USER],
  choices: { buttons: TEAMS_MAX_CARD_BUTTONS, list: TEAMS_MAX_CHOICE_LIST },
});
