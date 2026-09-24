import { z } from 'zod';
import type { ChannelKindDescriptor, ChannelMark, ChannelSetupFile } from '../contract/descriptor.js';
import { TeamsSettings } from './config.js';
import { TEAMS_KIND } from './render.js';

export const TEAMS_WEBHOOK_SEGMENT = 'ms-teams';
export const TEAMS_MARK: ChannelMark = { code: 'MT', name: 'Microsoft Teams' };

/**
 * A Teams app manifest (schema 1.17) for the channel's Azure Bot: the app id and the bot id are the
 * Microsoft App ID (`{{settings.appId}}`, filled by the web app from the saved channel). The bot answers in
 * personal chats, group chats and team channels. Teams wants it zipped with two icons (`color.png`
 * 192×192, `outline.png` 32×32 transparent).
 */
export const TEAMS_APP_MANIFEST = {
  $schema: 'https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json',
  manifestVersion: '1.17',
  version: '1.0.0',
  id: '{{settings.appId}}',
  developer: {
    name: 'Your organization',
    websiteUrl: 'https://www.example.com',
    privacyUrl: 'https://www.example.com/privacy',
    termsOfUseUrl: 'https://www.example.com/terms',
  },
  name: { short: 'OCSO Assistant', full: 'OCSO Assistant' },
  description: {
    short: 'Customer service assistant connected to OCSO.',
    full: 'Ask questions in a personal chat, or @mention the assistant in a group chat or channel. Answers come from the OCSO agent that handles this channel.',
  },
  icons: { color: 'color.png', outline: 'outline.png' },
  accentColor: '#1D2433',
  bots: [{ botId: '{{settings.appId}}', scopes: ['personal', 'team', 'groupChat'], supportsFiles: false, isNotificationOnly: false }],
  permissions: ['identity', 'messageTeamMembers'],
  validDomains: [],
} as const;

const MANIFEST_FILE: ChannelSetupFile = {
  key: 'teams-app-manifest',
  label: 'Teams app manifest',
  description:
    'Save it as manifest.json, replace the developer name and URLs with your organization’s, zip it with a color.png (192×192) and an outline.png (32×32) icon, and upload the zip in Teams (Apps → Manage your apps → Upload an app) or the Teams admin center.',
  filename: 'manifest.json',
  contentType: 'application/json',
  template: `${JSON.stringify(TEAMS_APP_MANIFEST, null, 2)}\n`,
};

export const TEAMS_DESCRIPTOR: ChannelKindDescriptor = {
  kind: TEAMS_KIND,
  label: 'Microsoft Teams',
  description:
    'People chat with your Azure Bot in Microsoft Teams, one to one or by @mentioning it in a group chat or channel: the Bot Connector posts each activity to the OCSO webhook (signed with Microsoft’s keys), and OCSO answers in the same chat or thread.',
  mark: TEAMS_MARK,
  settingsSchema: z.toJSONSchema(TeamsSettings, { io: 'input' }) as Record<string, unknown>,
  secrets: [
    {
      key: 'appPassword',
      label: 'Client secret',
      required: true,
      hint: 'The app registration’s client secret value (Azure Bot → Configuration → Manage Password → Certificates & secrets → New client secret). Copy the Value, not the Secret ID.',
    },
  ],
  setupSteps: [
    'In the Azure portal create an Azure Bot (Single Tenant unless people from other organizations must reach it), and copy its Microsoft App ID, and for a single-tenant bot the App Tenant ID, into this channel’s settings.',
    'Under the bot’s Configuration choose Manage Password, create a client secret and paste its Value into this channel’s Client secret.',
    'Set the bot’s Messaging endpoint (Configuration) to this channel’s webhook URL above and save.',
    'Under Channels add Microsoft Teams and accept the terms.',
    'Package the Teams app manifest below (with your two icons) and upload it in Teams or the Teams admin center; then open the app and send it a message. In group chats and channels people @mention it.',
    'Files people share are not imported yet: the assistant reads the text of each message only.',
    'Use Test connection: it requests a Bot Connector token with the app credentials and fetches Microsoft’s signing keys. The channel card shows the last inbound time.',
  ],
  setupFiles: [MANIFEST_FILE],
  inboundWebhook: true,
  webhookSegment: TEAMS_WEBHOOK_SEGMENT,
  webhookEvents: 'personal chats, @mentions, card button taps',
  embeddable: false,
  staffDestination: true,
  staffSurface: 'teams',
};
