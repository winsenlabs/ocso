import { describe, expect, it } from 'vitest';
import { ChannelMediaError, ChannelRegistry, createSlackChannelAdapter, SLACK_BOT_EVENTS, SLACK_BOT_SCOPES, setupFileProblems } from '../src/index.js';
import { slConfig, TEAM, USER } from './helpers/slack.js';

const adapter = createSlackChannelAdapter();

describe('Slack descriptor', () => {
  const descriptor = adapter.describe();

  it('registers as SLACK at /channels/slack/<publicKey>/webhook', () => {
    const registry = new ChannelRegistry().register(adapter);
    expect(registry.kindForWebhookSegment('slack')).toBe('SLACK');
    expect(registry.describe('SLACK')).toMatchObject({ label: 'Slack', mark: { code: 'SL' }, inboundWebhook: true, embeddable: false, connectionCheck: true, messageTemplates: false });
  });

  it('describes the settings form and write-only secrets', () => {
    const properties = (descriptor.settingsSchema as { properties: Record<string, { default?: unknown; enum?: unknown }> }).properties;
    expect(properties['replyInThread']?.default).toBe(true);
    expect(properties['respondTo']).toMatchObject({ default: 'dm_and_mentions', enum: ['dm', 'mentions', 'dm_and_mentions'] });
    expect(properties['allowedChannelIds']?.default).toEqual([]);
    expect(descriptor.secrets.map((s) => [s.key, s.required])).toEqual([
      ['botToken', true],
      ['signingSecret', true],
    ]);
  });

  it('ships a valid Slack app manifest with the webhook URL for events and interactivity', () => {
    expect(setupFileProblems(descriptor.setupFiles)).toEqual([]);
    const [file] = descriptor.setupFiles ?? [];
    expect(file).toMatchObject({ key: 'slack-app-manifest', contentType: 'application/json', filename: 'slack-app-manifest.json' });
    const filled = JSON.parse((file?.template ?? '').replaceAll('{{webhookUrl}}', 'https://ocso.example.com/channels/slack/k/webhook')) as {
      oauth_config: { scopes: { bot: string[] } };
      settings: { event_subscriptions: { request_url: string; bot_events: string[] }; interactivity: { is_enabled: boolean; request_url: string } };
    };
    expect(filled.oauth_config.scopes.bot.sort()).toEqual(['app_mentions:read', 'chat:write', 'im:history', 'users:read', 'users:read.email']);
    expect(filled.settings.event_subscriptions).toEqual({ request_url: 'https://ocso.example.com/channels/slack/k/webhook', bot_events: ['app_mention', 'message.im'] });
    expect(filled.settings.interactivity).toEqual({ is_enabled: true, request_url: 'https://ocso.example.com/channels/slack/k/webhook' });
    expect([...SLACK_BOT_SCOPES]).toContain('chat:write');
    expect([...SLACK_BOT_EVENTS]).toEqual(['app_mention', 'message.im']);
  });

  it('never puts secrets in the manifest or setup steps', () => {
    expect(JSON.stringify(descriptor.setupFiles)).not.toMatch(/secrets\.|xoxb-[A-Za-z0-9]/);
  });
});

describe('Slack config', () => {
  it('accepts defaults with both secrets', () => {
    expect(adapter.validateConfig({}, slConfig().secrets)).toEqual([]);
    expect(adapter.validateConfig({ respondTo: 'dm', replyInThread: false, allowedChannelIds: ['C0123ABCD', 'g0PRIVATE1'] }, slConfig().secrets)).toEqual([]);
  });

  it('names bad settings and secrets without echoing secret values', () => {
    const problems = adapter.validateConfig({ respondTo: 'everyone', allowedChannelIds: ['D0DM00001'], apiBaseUrl: 'http://slack.example.com/api' }, { botToken: 'xoxp-fake-test-token-05', signingSecret: 'short' });
    expect(problems.join('\n')).toMatch(/settings\.respondTo/);
    expect(problems.join('\n')).toMatch(/settings\.allowedChannelIds\.0/);
    expect(problems.join('\n')).toMatch(/settings\.apiBaseUrl/);
    expect(problems).toContain('secrets.botToken: use the Bot User OAuth Token (xoxb-…), not a user or refresh token');
    expect(problems.join('\n')).toMatch(/secrets\.signingSecret/);
    expect(problems.join('\n')).not.toContain('xoxp-fake-test-token-05');
    expect(adapter.validateConfig({}, {})).toEqual(['secrets.botToken: required', 'secrets.signingSecret: required']);
  });
});

describe('Slack identity and media', () => {
  it('shows the Slack user id in lists and leaves other kinds alone', () => {
    expect(adapter.displayIdentity('slack_user', `${TEAM}:${USER}`)).toBe(`slack · ${USER}`);
    expect(adapter.displayIdentity('whatsapp_phone', '+15550001')).toBeNull();
  });

  it('has no media to fetch in v1', async () => {
    await expect(adapter.fetchMedia({ source: 'slack', providerId: 'F1', status: 'PENDING' } as never, slConfig())).rejects.toBeInstanceOf(ChannelMediaError);
  });
});
