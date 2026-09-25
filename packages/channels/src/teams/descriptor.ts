import { z } from 'zod';
import type { ChannelKindDescriptor, ChannelMark, ChannelSetupFile, ChannelSetupStep, ChannelTroubleshooting } from '../contract/descriptor.js';
import { TeamsSettings } from './config.js';
import { TEAMS_COLOR_ICON_PNG, TEAMS_OUTLINE_ICON_PNG } from './icons.js';
import { TEAMS_KIND } from './render.js';

export const TEAMS_WEBHOOK_SEGMENT = 'ms-teams';
export const TEAMS_MARK: ChannelMark = { code: 'MT', name: 'Microsoft Teams' };

/** The Teams app manifest schema this package targets (learn.microsoft.com … /resources/schema/manifest-schema). */
export const TEAMS_MANIFEST_VERSION = '1.30';

/**
 * The Teams app manifest for the channel's Azure Bot: the app id and the bot id are the Microsoft App ID
 * (`{{settings.appId}}`, filled from the saved channel). The bot answers in personal chats, team channels and
 * group chats (the adapter handles all three). The developer links point at this OCSO's public origin.
 */
export const TEAMS_APP_MANIFEST = {
  $schema: `https://developer.microsoft.com/json-schemas/teams/v${TEAMS_MANIFEST_VERSION}/MicrosoftTeams.schema.json`,
  manifestVersion: TEAMS_MANIFEST_VERSION,
  version: '1.0.0',
  id: '{{settings.appId}}',
  developer: {
    name: 'OCSO',
    websiteUrl: 'https://{{webhookHost}}',
    privacyUrl: 'https://{{webhookHost}}',
    termsOfUseUrl: 'https://{{webhookHost}}',
  },
  name: { short: 'OCSO Assistant', full: 'OCSO Assistant' },
  description: {
    short: 'Customer service assistant connected to OCSO.',
    full: 'Ask questions in a personal chat, or @mention the assistant in a group chat or channel. Answers come from the OCSO agent that handles this channel.',
  },
  icons: { color: 'color.png', outline: 'outline.png' },
  accentColor: '#11171D',
  bots: [{ botId: '{{settings.appId}}', scopes: ['personal', 'team', 'groupChat'], supportsFiles: false, isNotificationOnly: false }],
  validDomains: ['{{webhookHost}}'],
} as const;

const APP_PACKAGE: ChannelSetupFile = {
  key: 'teams-app-package',
  label: 'Teams app package',
  description: 'A zip with manifest.json (this channel’s App ID as the app and bot id) and the two icons. Upload it in Teams or the Teams admin center. It never contains the client secret.',
  filename: 'ocso-teams-app.zip',
  contentType: 'application/zip',
  entries: [
    { path: 'manifest.json', contentType: 'application/json', template: `${JSON.stringify(TEAMS_APP_MANIFEST, null, 2)}\n` },
    { path: 'color.png', contentType: 'image/png', base64: TEAMS_COLOR_ICON_PNG },
    { path: 'outline.png', contentType: 'image/png', base64: TEAMS_OUTLINE_ICON_PNG },
  ],
};

const TEAMS_GUIDE: ChannelSetupStep[] = [
  {
    title: 'Create an Azure Bot',
    body: 'In the Azure portal choose Create a resource → Azure Bot, and fill in:',
    items: [
      'Bot handle: any unique name (people do not see it in Teams).',
      'Type of App: Single Tenant (recommended: only people in your Microsoft 365 tenant can reach it). Choose Multi Tenant only if people from other organizations must reach it.',
      'Creation type: Create new Microsoft App ID.',
      'Pricing tier: Standard channels such as Teams are free.',
    ],
    links: [{ label: 'Azure portal: create an Azure Bot', href: 'https://portal.azure.com/#create/Microsoft.AzureBot' }],
    check: 'The deployment finishes and the Azure Bot resource opens.',
  },
  {
    title: 'Record the Microsoft App ID and the Tenant ID',
    body: 'Open the bot’s Configuration page and choose Manage Password next to the Microsoft App ID: this opens the app registration. Its Overview shows both values.',
    items: ['Application (client) ID: the Microsoft App ID.', 'Directory (tenant) ID: the Tenant ID (needed for a Single Tenant bot).'],
  },
  {
    title: 'Create a client secret',
    body: 'In the app registration open Certificates & secrets → Client secrets → New client secret. Copy the Value (not the Secret ID) right away: Azure shows it only once.',
    items: ['Note the expiry date. Create a new secret and paste it into OCSO before the old one lapses, or the bot stops answering.'],
  },
  {
    title: 'Set the messaging endpoint',
    body: 'Back on the Azure Bot, open Configuration and set Messaging endpoint to this channel’s webhook URL, then Apply.',
    values: [{ label: 'Messaging endpoint', value: '{{webhookUrl}}' }],
  },
  {
    title: 'Add the Microsoft Teams channel',
    body: 'On the Azure Bot open Channels, choose Microsoft Teams, accept the terms of service and Apply.',
    check: 'Microsoft Teams is listed under Channels with status Healthy.',
  },
  {
    title: 'Paste the values into OCSO and save',
    body: 'Enter the Microsoft App ID, the app type, the Tenant ID and the client secret below, and save. The client secret is write-only.',
    form: true,
    check: 'Test connection gets a token from Microsoft Entra with these values.',
  },
  {
    title: 'Download the Teams app package and upload it',
    body: 'The package holds this channel’s App ID, so save the channel first. In Teams choose Apps → Manage your apps → Upload an app → Upload a custom app, and pick the zip.',
    files: ['teams-app-package'],
    items: [
      'Your organization must allow custom app upload (Teams admin center → Teams apps → Setup policies). If it does not, choose Submit an app to your org instead: a Teams admin approves it in the Teams admin center (Teams apps → Manage apps).',
      'To make the app available to everyone, a Teams admin can upload it in the Teams admin center.',
    ],
    links: [{ label: 'Upload your app in Teams', href: 'https://learn.microsoft.com/microsoftteams/platform/concepts/deploy-and-publish/apps-upload' }],
  },
  {
    title: 'Test',
    body: 'Use Test connection below, then activate the channel (a second person approves it). Once it is live, open the app in Teams and send it a message. In group chats and channels, @mention it.',
    items: ['Files people share are not imported yet: the assistant reads the text of each message only.'],
    check: 'The assistant replies, and the channel card shows the last inbound time.',
  },
];

const TEAMS_TROUBLESHOOTING: ChannelTroubleshooting[] = [
  {
    id: 'unauthorized',
    problem: 'Messages are refused with 401, or Test connection cannot get a token',
    fix: 'Check that the Microsoft App ID is the app registration’s Application (client) ID, that the Tenant ID is its Directory (tenant) ID, and that App type matches what the Azure Bot was created with (Single Tenant vs Multi Tenant). A single-tenant bot set up as multi-tenant in OCSO (or the reverse) is refused.',
  },
  {
    id: 'secret-invalid',
    problem: 'Microsoft Entra says the client secret is invalid (AADSTS7000215)',
    fix: 'Paste the secret’s Value, not its Secret ID. If you lost the Value, create a new client secret in Certificates & secrets and paste that.',
  },
  {
    id: 'secret-expired',
    problem: 'The client secret expired (AADSTS7000222)',
    fix: 'Create a new client secret in the app registration (Certificates & secrets), paste its Value into this channel and save. On a live channel the change is approved by a second person, so rotate before the expiry date.',
  },
  {
    id: 'custom-apps-blocked',
    problem: 'Teams does not offer Upload a custom app',
    fix: 'Your organization blocks custom app upload. Choose Submit an app to your org (a Teams admin approves it in the Teams admin center), or ask a Teams admin to allow custom apps for you in a setup policy.',
  },
  {
    id: 'no-reply-in-channel',
    problem: 'No reply in a team channel or group chat',
    fix: 'In channels and group chats the bot only receives messages that @mention it. Mention it by name. In a team channel the app must also be added to that team.',
  },
  {
    id: 'endpoint-not-https',
    problem: 'Test connection says the messaging endpoint is not https',
    fix: 'Azure Bot Service only calls public https endpoints. Set OCSO_PUBLIC_URL to the https origin Microsoft can reach, restart OCSO, and use the webhook URL it then shows.',
  },
];

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
      hint: 'The app registration’s client secret Value (Azure Bot → Configuration → Manage Password → Certificates & secrets → New client secret). Copy the Value, not the Secret ID, and note its expiry.',
    },
  ],
  setupGuide: TEAMS_GUIDE,
  troubleshooting: TEAMS_TROUBLESHOOTING,
  setupFiles: [APP_PACKAGE],
  inboundWebhook: true,
  webhookSegment: TEAMS_WEBHOOK_SEGMENT,
  webhookEvents: 'personal chats, @mentions, card button taps',
  embeddable: false,
  staffDestination: true,
  staffSurface: 'teams',
};
