import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  ChannelMediaError,
  ChannelRegistry,
  createSlackChannelAdapter,
  renderSetupFile,
  SLACK_APP_MANIFEST,
  SLACK_BOT_EVENTS,
  SLACK_BOT_SCOPES,
  SLACK_REQUIRED_SCOPES,
  setupFileProblems,
  setupGuideProblems,
} from '../src/index.js';
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

  it('ships the Slack app manifest as YAML and JSON, complete and with the webhook URL for events and interactivity', () => {
    expect(setupFileProblems(descriptor.setupFiles)).toEqual([]);
    const [yamlFile, jsonFile] = descriptor.setupFiles ?? [];
    expect(yamlFile).toMatchObject({ key: 'slack-app-manifest-yaml', contentType: 'text/yaml', filename: 'slack-app-manifest.yaml' });
    expect(jsonFile).toMatchObject({ key: 'slack-app-manifest', contentType: 'application/json', filename: 'slack-app-manifest.json' });
    const ctx = { webhookUrl: 'https://ocso.example.com/channels/slack/k_Ab-1/webhook', settings: {} };
    const text = (file: typeof yamlFile) => {
      const out = renderSetupFile(file!, ctx);
      expect(out.missing).toEqual([]);
      return new TextDecoder().decode(out.files[0]!.data);
    };
    const fromJson = JSON.parse(text(jsonFile)) as unknown;
    const fromYaml = parseYaml(text(yamlFile)) as unknown;
    // The two formats carry exactly the same manifest.
    expect(fromYaml).toEqual(fromJson);
    const m = fromJson as typeof SLACK_APP_MANIFEST;
    expect(m.display_information.name.length).toBeLessThanOrEqual(35);
    expect(m.features.bot_user.display_name).toMatch(/^[a-z0-9._-]{1,80}$/);
    expect(m.features.app_home).toEqual({ home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false });
    expect([...m.oauth_config.scopes.bot].sort()).toEqual(['app_mentions:read', 'chat:write', 'im:history', 'users:read', 'users:read.email']);
    expect(m.settings.event_subscriptions).toEqual({ request_url: ctx.webhookUrl, bot_events: ['app_mention', 'message.im'] });
    expect(m.settings.interactivity).toEqual({ is_enabled: true, request_url: ctx.webhookUrl });
    expect(m.settings).toMatchObject({ socket_mode_enabled: false, token_rotation_enabled: false, org_deploy_enabled: false });
    expect([...SLACK_BOT_EVENTS]).toEqual(['app_mention', 'message.im']);
    // Every scope the adapter's calls and events need is required; the check fails without them.
    expect([...SLACK_REQUIRED_SCOPES].sort()).toEqual(['app_mentions:read', 'chat:write', 'im:history']);
    expect(SLACK_BOT_SCOPES).toEqual(m.oauth_config.scopes.bot);
  });

  it('guides the setup step by step: manifest, scopes table, install, secrets form, verification, test', () => {
    const guide = descriptor.setupGuide ?? [];
    expect(setupGuideProblems(descriptor)).toEqual([]);
    expect(guide).toHaveLength(10);
    expect(guide[0]).toMatchObject({ title: 'Create the Slack app from the manifest', files: ['slack-app-manifest-yaml', 'slack-app-manifest'] });
    expect(guide[1]?.table?.rows.map((r) => r[0])).toEqual([...SLACK_BOT_SCOPES]);
    expect(guide.findIndex((s) => s.form)).toBe(4);
    expect(guide[5]?.values).toEqual([{ label: 'Request URL', value: '{{webhookUrl}}' }]);
    expect(guide[7]?.body).toContain('Allow users to send Slash commands and messages from the messages tab');
    expect(guide[8]?.body).toContain('/invite');
    const ids = descriptor.troubleshooting?.map((t) => t.id) ?? [];
    for (const id of ['url-not-verified', 'not-in-channel', 'missing-scope', 'dms-not-arriving', 'signing-secret-rotated', 'enterprise-grid']) expect(ids).toContain(id);
  });

  it('never puts secrets in the manifest or setup guide', () => {
    expect(JSON.stringify([descriptor.setupFiles, descriptor.setupGuide])).not.toMatch(/secrets\.|xoxb-[A-Za-z0-9]/);
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
