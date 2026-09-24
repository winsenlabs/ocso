import { z } from 'zod';
import type { ChannelKindDescriptor, ChannelMark, ChannelSetupFile } from '../contract/descriptor.js';
import { SlackSettings } from './config.js';

export const SLACK_WEBHOOK_SEGMENT = 'slack';
export const SLACK_MARK: ChannelMark = { code: 'SL', name: 'Slack' };

/** Bot scopes the adapter uses: reply, read DMs and mentions, and look up who wrote. */
export const SLACK_BOT_SCOPES = ['app_mentions:read', 'chat:write', 'im:history', 'users:read', 'users:read.email'] as const;
export const SLACK_BOT_EVENTS = ['app_mention', 'message.im'] as const;

/**
 * A Slack app manifest (api.slack.com/reference/manifests) with the channel's webhook as both the Events API
 * and the interactivity Request URL. The web app fills `{{webhookUrl}}` from the saved channel.
 */
export const SLACK_APP_MANIFEST = {
  display_information: {
    name: 'OCSO Assistant',
    description: 'Customer service assistant connected to OCSO.',
    background_color: '#1d2433',
  },
  features: {
    app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    bot_user: { display_name: 'OCSO Assistant', always_online: true },
  },
  oauth_config: { scopes: { bot: [...SLACK_BOT_SCOPES] } },
  settings: {
    event_subscriptions: { request_url: '{{webhookUrl}}', bot_events: [...SLACK_BOT_EVENTS] },
    interactivity: { is_enabled: true, request_url: '{{webhookUrl}}' },
    org_deploy_enabled: false,
    socket_mode_enabled: false,
    token_rotation_enabled: false,
  },
} as const;

const MANIFEST_FILE: ChannelSetupFile = {
  key: 'slack-app-manifest',
  label: 'Slack app manifest',
  description: 'Paste it at api.slack.com/apps → Create New App → From a manifest (JSON). Rename the app and bot as you like.',
  filename: 'slack-app-manifest.json',
  contentType: 'application/json',
  template: `${JSON.stringify(SLACK_APP_MANIFEST, null, 2)}\n`,
};

export const SLACK_DESCRIPTOR: ChannelKindDescriptor = {
  kind: 'SLACK',
  label: 'Slack',
  description:
    'Customers or colleagues message your Slack app directly or @mention it in channels: Slack posts events and button clicks to the OCSO webhook, and OCSO answers with the bot token (in the DM, or in a thread under the mention).',
  mark: SLACK_MARK,
  settingsSchema: z.toJSONSchema(SlackSettings, { io: 'input' }) as Record<string, unknown>,
  secrets: [
    {
      key: 'botToken',
      label: 'Bot token',
      required: true,
      hint: 'Bot User OAuth Token (xoxb-…): the app’s OAuth & Permissions page, after installing it to your workspace.',
    },
    {
      key: 'signingSecret',
      label: 'Signing secret',
      required: true,
      hint: 'Basic Information → App Credentials → Signing Secret. OCSO verifies every request Slack sends with it.',
    },
  ],
  setupSteps: [
    'At api.slack.com/apps choose Create New App → From a manifest, pick your workspace and paste the app manifest below (it already holds this webhook URL for events and interactivity).',
    'Install the app to your workspace, then copy the Bot User OAuth Token (xoxb-…) from OAuth & Permissions and the Signing Secret from Basic Information into this channel’s secrets.',
    'Under Event Subscriptions Slack checks the Request URL once the channel is active; if it shows as unverified, choose Retry.',
    'Invite the app to the channels where it should answer @mentions (/invite @your-app); direct messages work as soon as it is installed.',
    'Files people share are not imported yet: the assistant reads the text of each message only.',
    'Use Test connection, then send the app a direct message; the channel card shows the last inbound time.',
  ],
  setupFiles: [MANIFEST_FILE],
  inboundWebhook: true,
  webhookSegment: SLACK_WEBHOOK_SEGMENT,
  webhookEvents: 'direct messages, @mentions, button clicks',
  embeddable: false,
  staffDestination: true,
};
