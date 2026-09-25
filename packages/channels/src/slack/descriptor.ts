import { z } from 'zod';
import type { ChannelKindDescriptor, ChannelMark, ChannelSetupFile, ChannelSetupStep, ChannelTroubleshooting } from '../contract/descriptor.js';
import { SlackSettings } from './config.js';

export const SLACK_WEBHOOK_SEGMENT = 'slack';
export const SLACK_MARK: ChannelMark = { code: 'SL', name: 'Slack' };

/**
 * Every bot scope the app manifest requests, why, and what breaks without it. `required` scopes back a call or
 * an event the adapter uses today (the connection check fails without them); the others are requested so
 * profile lookups can be added without reinstalling the app, and the check only notes them.
 */
export const SLACK_SCOPES = [
  { scope: 'chat:write', required: true, why: 'Post the assistant’s replies (chat.postMessage) in DMs and in threads under @mentions.', breaks: 'OCSO cannot reply: every send fails with missing_scope' },
  { scope: 'im:history', required: true, why: 'Receive direct messages to the app (the message.im event).', breaks: 'direct messages to the app never reach OCSO' },
  { scope: 'app_mentions:read', required: true, why: 'Receive @mentions of the app in channels (the app_mention event).', breaks: '@mentions in channels never reach OCSO' },
  { scope: 'users:read', required: false, why: 'Read the profile of the person writing (name). OCSO does not call it yet; requested so profile lookups work without a reinstall.', breaks: 'nothing today' },
  { scope: 'users:read.email', required: false, why: 'Read that person’s email address, to match Slack users to OCSO users. Not called yet either; same reason.', breaks: 'nothing today' },
] as const;

/** Bot scopes the app manifest requests. */
export const SLACK_BOT_SCOPES = SLACK_SCOPES.map((s) => s.scope);
/** Scopes the adapter cannot work without (the connection check fails when one is missing). */
export const SLACK_REQUIRED_SCOPES = SLACK_SCOPES.filter((s) => s.required).map((s) => s.scope);
export const SLACK_BOT_EVENTS = ['app_mention', 'message.im'] as const;

/**
 * A Slack app manifest (docs.slack.dev/reference/app-manifest) with the channel's webhook as both the Events
 * API and the interactivity Request URL. OCSO fills `{{webhookUrl}}` from the channel. The bot's display name
 * allows only a-z, 0-9, `-`, `_` and `.`.
 */
export const SLACK_APP_MANIFEST = {
  display_information: {
    name: 'OCSO Assistant',
    description: 'Customer service assistant connected to OCSO.',
    background_color: '#11171d',
  },
  features: {
    app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    bot_user: { display_name: 'ocso-assistant', always_online: true },
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

/** The same manifest as YAML (Slack's editor defaults to YAML). Strings that YAML could misread are quoted. */
export function slackManifestYaml(manifest: typeof SLACK_APP_MANIFEST = SLACK_APP_MANIFEST): string {
  const m = manifest;
  const list = (items: readonly string[], indent: string) => items.map((i) => `${indent}- ${i}`).join('\n');
  return `display_information:
  name: ${m.display_information.name}
  description: ${m.display_information.description}
  background_color: "${m.display_information.background_color}"
features:
  app_home:
    home_tab_enabled: ${m.features.app_home.home_tab_enabled}
    messages_tab_enabled: ${m.features.app_home.messages_tab_enabled}
    messages_tab_read_only_enabled: ${m.features.app_home.messages_tab_read_only_enabled}
  bot_user:
    display_name: ${m.features.bot_user.display_name}
    always_online: ${m.features.bot_user.always_online}
oauth_config:
  scopes:
    bot:
${list(m.oauth_config.scopes.bot, '      ')}
settings:
  event_subscriptions:
    request_url: ${m.settings.event_subscriptions.request_url}
    bot_events:
${list(m.settings.event_subscriptions.bot_events, '      ')}
  interactivity:
    is_enabled: ${m.settings.interactivity.is_enabled}
    request_url: ${m.settings.interactivity.request_url}
  org_deploy_enabled: ${m.settings.org_deploy_enabled}
  socket_mode_enabled: ${m.settings.socket_mode_enabled}
  token_rotation_enabled: ${m.settings.token_rotation_enabled}
`;
}

const MANIFEST_YAML: ChannelSetupFile = {
  key: 'slack-app-manifest-yaml',
  label: 'Slack app manifest (YAML)',
  description: 'Paste it at api.slack.com/apps → Create New App → From an app manifest. It holds this channel’s webhook URL for events and interactivity.',
  filename: 'slack-app-manifest.yaml',
  contentType: 'text/yaml',
  template: slackManifestYaml(),
};

const MANIFEST_JSON: ChannelSetupFile = {
  key: 'slack-app-manifest',
  label: 'Slack app manifest (JSON)',
  description: 'The same manifest as JSON, for the JSON tab of Slack’s manifest editor.',
  filename: 'slack-app-manifest.json',
  contentType: 'application/json',
  template: `${JSON.stringify(SLACK_APP_MANIFEST, null, 2)}\n`,
};

const SLACK_GUIDE: ChannelSetupStep[] = [
  {
    title: 'Create the Slack app from the manifest',
    body: 'At api.slack.com/apps choose Create New App → From an app manifest, pick the workspace, paste the manifest (YAML or JSON tab) and create the app. The manifest already holds this channel’s webhook URL, the bot user, the scopes and the events. You can rename the app and the bot before creating it.',
    files: ['slack-app-manifest-yaml', 'slack-app-manifest'],
    values: [{ label: 'Request URL', value: '{{webhookUrl}}' }],
    links: [
      { label: 'Your Slack apps', href: 'https://api.slack.com/apps' },
      { label: 'App manifest reference', href: 'https://docs.slack.dev/reference/app-manifest' },
    ],
    check: 'Slack may say the Request URL is not verified yet. That is expected until step 6.',
  },
  {
    title: 'Review the bot token scopes',
    body: 'Open OAuth & Permissions → Scopes → Bot Token Scopes. The manifest requested these:',
    table: { head: ['Scope', 'Why OCSO needs it'], rows: SLACK_SCOPES.map((s) => [s.scope, `${s.required ? '' : 'Optional. '}${s.why}`] as const) },
    values: [{ label: 'Bot scopes', value: SLACK_BOT_SCOPES.join(',') }],
    check: 'If you add or remove a scope later, reinstall the app (step 3) or Slack keeps the old grant.',
  },
  {
    title: 'Install the app to your workspace',
    body: 'Under Install App (or OAuth & Permissions) choose Install to Workspace and allow the permissions.',
    items: [
      'If your workspace restricts app installs, Slack sends a request to a workspace admin instead. The app works once they approve it.',
      'On Enterprise Grid, an org admin may also need to approve the app and add it to this workspace.',
    ],
    check: 'OAuth & Permissions now shows a Bot User OAuth Token (xoxb-…).',
  },
  {
    title: 'Copy the bot token and the signing secret',
    body: 'Copy two values from the app’s settings. Keep them out of chat and tickets: paste them only into OCSO’s form.',
    items: ['Bot User OAuth Token (xoxb-…): OAuth & Permissions → OAuth Tokens.', 'Signing Secret: Basic Information → App Credentials → Signing Secret (Show).'],
  },
  {
    title: 'Paste them into OCSO and save',
    body: 'Enter the bot token and the signing secret below, choose what the app answers (DMs, @mentions or both), and save. Secrets are write-only: OCSO stores them and never shows them again.',
    form: true,
    check: 'The channel card lists botToken and signingSecret as set.',
  },
  {
    title: 'Verify the Request URL under Event Subscriptions',
    body: 'In Slack open Event Subscriptions. Once the channel is saved with the signing secret, OCSO answers Slack’s challenge (even while the channel is a draft). If the Request URL shows as not verified, choose Retry.',
    values: [{ label: 'Request URL', value: '{{webhookUrl}}' }],
    items: ['Subscribed bot events: app_mention and message.im.'],
    check: 'The Request URL shows Verified ✓.',
  },
  {
    title: 'Check Interactivity',
    body: 'Under Interactivity & Shortcuts, Interactivity is on with the same Request URL. Button taps on the assistant’s messages arrive there.',
    values: [{ label: 'Request URL', value: '{{webhookUrl}}' }],
  },
  {
    title: 'Allow messages in App Home',
    body: 'Under App Home → Show Tabs, turn on the Messages Tab and check “Allow users to send Slash commands and messages from the messages tab”. Without it people cannot DM the app.',
  },
  {
    title: 'Invite the bot to channels',
    body: 'In each channel where the app should answer @mentions, type /invite @ocso-assistant (or your bot’s name). Direct messages need no invite.',
    items: ['To limit which channels are answered, list their ids (C…) under Allowed channels in OCSO’s settings.'],
  },
  {
    title: 'Test',
    body: 'Use Test connection below, then activate the channel (a second person approves it). Once it is live, send the app a direct message in Slack.',
    items: ['Files people share are not imported yet: the assistant reads the text of each message only.'],
    check: 'The assistant replies, and the channel card shows the last inbound time.',
  },
];

const SLACK_TROUBLESHOOTING: ChannelTroubleshooting[] = [
  {
    id: 'url-not-verified',
    problem: 'Event Subscriptions says the Request URL is not verified',
    fix: 'Save the channel in OCSO with the signing secret first, then choose Retry in Slack. OCSO answers the challenge only for requests signed with that secret. Check that the URL is exactly the webhook URL shown here and that OCSO_PUBLIC_URL is an https origin Slack can reach.',
  },
  {
    id: 'not-in-channel',
    problem: 'Replies to @mentions fail with not_in_channel',
    fix: 'The bot is not a member of that channel. Type /invite @your-bot in the channel, then mention it again.',
  },
  {
    id: 'missing-scope',
    problem: 'Slack answers missing_scope, or Test connection lists a missing scope',
    fix: 'Add the scope under OAuth & Permissions → Bot Token Scopes (or re-paste the manifest), then reinstall the app to the workspace: a scope change only takes effect after reinstalling. If reinstalling gives a new bot token, paste it into OCSO.',
  },
  {
    id: 'dms-not-arriving',
    problem: 'Direct messages to the app never arrive',
    fix: 'Turn on App Home → Messages Tab and check “Allow users to send Slash commands and messages from the messages tab”. Check that the im:history scope is granted and message.im is subscribed under Event Subscriptions (reinstall after changing them), and that Respond to includes DMs.',
  },
  {
    id: 'signing-secret-rotated',
    problem: 'Every Slack request is refused after the signing secret was regenerated',
    fix: 'Slack signs with the new secret at once. Paste the new Signing Secret (Basic Information → App Credentials) into this channel and save. A live channel needs the change approved first, so rotate when a checker is available.',
  },
  {
    id: 'bot-token-invalid',
    problem: 'Test connection says Slack rejected the bot token',
    fix: 'The token was revoked or the app was uninstalled. Reinstall the app, copy the new Bot User OAuth Token (xoxb-…) and paste it into this channel.',
  },
  {
    id: 'enterprise-grid',
    problem: 'Enterprise Grid: the app is installed but a workspace cannot use it',
    fix: 'On Enterprise Grid an org admin approves apps and chooses the workspaces they are added to. Ask them to add the app to each workspace that needs it. The manifest keeps org-wide deployment off, so each workspace installs it separately.',
  },
  {
    id: 'request-url-not-https',
    problem: 'Test connection says the Request URL is not https',
    fix: 'Slack only calls public https URLs. Set OCSO_PUBLIC_URL to the https origin Slack can reach, restart OCSO, and use the webhook URL it then shows.',
  },
];

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
  setupGuide: SLACK_GUIDE,
  troubleshooting: SLACK_TROUBLESHOOTING,
  setupFiles: [MANIFEST_YAML, MANIFEST_JSON],
  inboundWebhook: true,
  webhookSegment: SLACK_WEBHOOK_SEGMENT,
  webhookEvents: 'direct messages, @mentions, button clicks',
  embeddable: false,
  staffDestination: true,
};
