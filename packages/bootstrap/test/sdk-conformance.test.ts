import { ALERT_EVENTS as INTERNAL_ALERT_EVENTS, DESTINATION_KIND_PATTERN as INTERNAL_DESTINATION_KIND, type AlertDeliveryAdapter } from '@ocso/alerts';
import {
  CHANNEL_KIND_PATTERN as INTERNAL_CHANNEL_KIND,
  EMBED_PAGE_PREFIX as INTERNAL_EMBED_PAGE_PREFIX,
  REPLY_CONTEXT_MAX_BYTES as INTERNAL_REPLY_CONTEXT_MAX_BYTES,
  REPLY_CONTEXT_MAX_KEYS as INTERNAL_REPLY_CONTEXT_MAX_KEYS,
  defaultWebhookSegment as internalDefaultWebhookSegment,
  originAllowed as internalOriginAllowed,
  type ChannelAdapter,
  type ChannelKindDescriptor,
} from '@ocso/channels';
import { ErrorCategory as InternalErrorCategory, RETRIABLE_CATEGORIES as INTERNAL_RETRIABLE, choicesOf as internalChoicesOf, isCustomerRenderable as internalRenderable, PART_TYPES } from '@ocso/domain';
import type { EmailDriverDefinition } from '@ocso/email';
import { PROVIDER_KIND_PATTERN as INTERNAL_PROVIDER_KIND, type ProviderDefinition } from '@ocso/model-providers';
import * as Sdk from '@winsendotai/ocso-plugin-sdk';
import { checkPlugin } from '@winsendotai/ocso-plugin-sdk/testing';
import { describe, expect, it } from 'vitest';
import { createAlertDeliveryRegistry } from '../src/alerts.js';
import { createDriverRegistries, DRIVER_NAME_PATTERN as INTERNAL_DRIVER_NAME, pluginShapeProblems } from '../src/index.js';
import { createChannelRegistry } from '../src/channels.js';
import { FIRST_PARTY_PLUGINS } from '../src/first-party.js';
import { createProviderRegistry } from '../src/model-adapters.js';
import type { OcsoPlugin } from '../src/plugin.js';

/**
 * The SDK's `checkPlugin` runs copies of the registries' checks. These tests
 * run both over every first-party contribution, and over broken variants of
 * them, and require the same verdict. (The type-level twin of this test is
 * sdk-conformance.types.ts.)
 */

const noFetch = () => Promise.reject(new Error('no network in tests'));
const PUBLIC_KEYS = ['channels', 'modelProviders', 'alertDestinations', 'emailDrivers'] as const;

/** A first-party plugin's public contributions, as an SDK plugin (renamed out of the reserved @ocso/ scope). */
function asSdkPlugin(plugin: OcsoPlugin, name = plugin.name.replace(/^@ocso\//, '@acme/')): Sdk.OcsoPluginV1 & OcsoPlugin {
  const out: Record<string, unknown> = { apiVersion: 1, name };
  for (const key of PUBLIC_KEYS) if (plugin[key]) out[key] = plugin[key];
  return out as unknown as Sdk.OcsoPluginV1 & OcsoPlugin;
}

/** The internal registries' verdict on one plugin: null = registered, else the first error. */
function registriesVerdict(plugin: OcsoPlugin): string | null {
  try {
    createChannelRegistry({ fetch: noFetch }, [plugin]);
    createProviderRegistry({ OCSO_ENABLE_DEV_PROVIDERS: true }, [plugin]);
    createAlertDeliveryRegistry({ fetch: noFetch }, [plugin]);
    createDriverRegistries([plugin]);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function expectAgreement(plugin: Sdk.OcsoPluginV1 & OcsoPlugin, expectRejected: boolean): void {
  const internal = registriesVerdict(plugin);
  const problems = checkPlugin(plugin);
  expect({ internalRejects: internal !== null, sdkRejects: problems.length > 0 }, `registry: ${internal ?? 'ok'}; sdk: ${problems.join(' | ') || 'ok'}`).toEqual({
    internalRejects: expectRejected,
    sdkRejects: expectRejected,
  });
}

const firstParty = FIRST_PARTY_PLUGINS.map((p) => asSdkPlugin(p)).filter((p) => PUBLIC_KEYS.some((k) => p[k]?.length));
const channelFactories = FIRST_PARTY_PLUGINS.flatMap((p) => p.channels ?? []);
const alertFactories = FIRST_PARTY_PLUGINS.flatMap((p) => p.alertDestinations ?? []);
const providers = FIRST_PARTY_PLUGINS.flatMap((p) => p.modelProviders ?? []);
const emailDrivers = FIRST_PARTY_PLUGINS.flatMap((p) => p.emailDrivers ?? []);

const build = (factory: (typeof channelFactories)[number]): ChannelAdapter => factory({ fetch: noFetch, now: () => new Date() });
const adapterWhere = (test: (a: ChannelAdapter) => boolean): ChannelAdapter => {
  const found = channelFactories.map(build).find(test);
  if (!found) throw new Error('no first-party channel matches');
  return found;
};

/** A first-party channel adapter with its descriptor or members changed. */
function brokenChannel(base: ChannelAdapter, descriptor: Partial<ChannelKindDescriptor>, members: { [K in keyof ChannelAdapter]?: ChannelAdapter[K] | undefined } = {}): ChannelAdapter {
  const describe = { ...base.describe(), ...descriptor };
  return Object.assign(Object.create(Object.getPrototypeOf(base) as object) as ChannelAdapter, base, { describe: () => describe }, members);
}

const pluginWith = (contribution: Partial<OcsoPlugin>): Sdk.OcsoPluginV1 & OcsoPlugin => ({ apiVersion: 1, name: '@acme/broken', ...contribution }) as Sdk.OcsoPluginV1 & OcsoPlugin;

describe('SDK checkPlugin agrees with the internal registries', () => {
  it('covers first-party contributions of every public kind', () => {
    expect(channelFactories.length).toBeGreaterThan(0);
    expect(alertFactories.length).toBeGreaterThan(0);
    expect(providers.length).toBeGreaterThan(0);
    expect(emailDrivers.length).toBeGreaterThan(0);
  });

  it.each(firstParty.map((p) => [p.name, p] as const))('accepts first-party %s', (_name, plugin) => {
    expect(checkPlugin(plugin)).toEqual([]);
    expectAgreement(plugin, false);
  });

  it('accepts all first-party public contributions together', () => {
    const all = pluginWith({ channels: channelFactories, alertDestinations: alertFactories, modelProviders: providers, emailDrivers });
    expectAgreement(all, false);
  });

  const webchat = () => adapterWhere((a) => a.describe().embeddable);
  const templated = () => adapterWhere((a) => Boolean(a.describe().templates));
  const webhook = () => adapterWhere((a) => a.describe().inboundWebhook);

  const channelCases: [string, () => ChannelAdapter[]][] = [
    ['a lower-case kind', () => [brokenChannel(webhook(), { kind: 'bad' }, { kind: 'bad' })]],
    ['a descriptor naming another kind', () => [brokenChannel(webhook(), { kind: 'SOMETHING_ELSE' })]],
    ['a long mark code', () => [brokenChannel(webhook(), { mark: { code: 'ABCD', name: 'x' } })]],
    ['an embeddable descriptor without embed hooks', () => [brokenChannel(webhook(), { embeddable: true })]],
    ['embed hooks on a non-embeddable descriptor', () => [brokenChannel(webchat(), { embeddable: false })]],
    ['a descriptor without embeddable (plain JS)', () => [brokenChannel(webhook(), { embeddable: undefined } as never)]],
    ['a descriptor without embeddable but with embed hooks', () => [brokenChannel(webchat(), { embeddable: undefined } as never)]],
    ['templates described but not implemented', () => [brokenChannel(webhook(), { templates: { reviewer: 'x', placeholderScope: 'template' } }, { listTemplates: undefined, createTemplate: undefined, sendTemplate: undefined })]],
    ['templates implemented but not described', () => [brokenChannel(templated(), { templates: undefined })]],
    ['an invalid webhook segment', () => [brokenChannel(webhook(), { webhookSegment: 'Not_Valid' })]],
    ['the same kind twice', () => [webhook(), webhook()]],
    ['a setup file with a secret placeholder', () => [brokenChannel(webhook(), { setupFiles: [{ key: 'manifest', label: 'M', filename: 'm.json', contentType: 'application/json', template: '{"t":"{{secrets.token}}"}' }] })]],
    ['a setup file with an unknown placeholder', () => [brokenChannel(webhook(), { setupFiles: [{ key: 'manifest', label: 'M', filename: 'm.json', contentType: 'application/json', template: '{"u":"{{publicKey}}"}' }] })]],
    ['a setup file with a bad filename', () => [brokenChannel(webhook(), { setupFiles: [{ key: 'manifest', label: 'M', filename: '../m.json', contentType: 'application/json', template: '{}' }] })]],
    ['a setup file with an unknown content type', () => [brokenChannel(webhook(), { setupFiles: [{ key: 'manifest', label: 'M', filename: 'm.html', contentType: 'text/html' as never, template: '<p/>' }] })]],
    ['two setup files with one key', () => [brokenChannel(webhook(), { setupFiles: [0, 1].map(() => ({ key: 'manifest', label: 'M', filename: 'm.json', contentType: 'application/json' as const, template: '{}' })) })]],
    ['a setup guide link that is not https', () => [brokenChannel(webhook(), { setupGuide: [{ title: 'T', body: '', links: [{ label: 'x', href: 'javascript:alert(1)' }] }] })]],
    ['a setup guide value with a secret placeholder', () => [brokenChannel(webhook(), { setupGuide: [{ title: 'T', body: '', values: [{ label: 'x', value: '{{secrets.token}}' }] }] })]],
    ['a setup guide step naming an unknown file', () => [brokenChannel(webhook(), { setupFiles: [], setupGuide: [{ title: 'T', body: '', files: ['nope'] }] })]],
    ['two form steps in a setup guide', () => [brokenChannel(webhook(), { setupGuide: [{ title: 'A', body: '', form: true }, { title: 'B', body: '', form: true }] })]],
    ['a setup guide step without a title', () => [brokenChannel(webhook(), { setupGuide: [{ title: '', body: 'b' }] })]],
    ['duplicate troubleshooting ids', () => [brokenChannel(webhook(), { troubleshooting: [{ id: 'a', problem: 'p', fix: 'f' }, { id: 'a', problem: 'p', fix: 'f' }] })]],
    ['a zip setup file without entries', () => [brokenChannel(webhook(), { setupFiles: [{ key: 'pkg', label: 'P', filename: 'p.zip', contentType: 'application/zip', entries: [] }] })]],
    ['a zip entry outside the package root', () => [brokenChannel(webhook(), { setupFiles: [{ key: 'pkg', label: 'P', filename: 'p.zip', contentType: 'application/zip', entries: [{ path: '../m.json', contentType: 'application/json', template: '{}' }] }] })]],
    ['a zip image entry that is not base64', () => [brokenChannel(webhook(), { setupFiles: [{ key: 'pkg', label: 'P', filename: 'p.zip', contentType: 'application/zip', entries: [{ path: 'c.png', contentType: 'image/png', base64: 'not base64!' }] }] })]],
    ['a non-boolean staffDestination', () => [brokenChannel(webhook(), { staffDestination: 'yes' as never })]],
    ['an invalid staffSurface', () => [brokenChannel(webhook(), { staffDestination: true, staffSurface: 'MS Teams' })]],
    ['a staff-destination kind declaring its own destination setting', () => [brokenChannel(webhook(), { staffDestination: true, settingsSchema: { type: 'object', properties: { destination: { type: 'string' } } } })]],
    ['the same webhook segment twice', () => [webhook(), brokenChannel(webhook(), { kind: 'OTHER_KIND', webhookSegment: webhook().describe().webhookSegment ?? internalDefaultWebhookSegment(webhook().kind) }, { kind: 'OTHER_KIND' })]],
  ];
  it('both accept a channel with valid setup files', () => {
    const files = [
      { key: 'manifest', label: 'App manifest', filename: 'manifest.json', contentType: 'application/json' as const, template: '{"url":"{{webhookUrl}}","id":"{{ settings.appId }}"}' },
      { key: 'yaml', label: 'YAML', filename: 'manifest.yaml', contentType: 'text/yaml' as const, template: 'url: {{webhookUrl}}\n' },
    ];
    expectAgreement(pluginWith({ channels: [() => brokenChannel(webhook(), { setupFiles: files })] }), false);
  });

  it('both accept a channel with a setup guide, troubleshooting and a zip package', () => {
    const files = [
      {
        key: 'pkg',
        label: 'App package',
        filename: 'app.zip',
        contentType: 'application/zip' as const,
        entries: [
          { path: 'manifest.json', contentType: 'application/json' as const, template: '{"id":"{{settings.appId}}","d":["{{webhookHost}}"]}' },
          { path: 'color.png', contentType: 'image/png' as const, base64: 'iVBORw0KGgo=' },
        ],
      },
    ];
    const setupGuide = [
      { title: 'Create the app', body: 'Upload the package.', files: ['pkg'], links: [{ label: 'Console', href: 'https://example.com' }], values: [{ label: 'URL', value: '{{webhookUrl}}' }] },
      { title: 'Paste the keys', body: '', form: true, table: { head: ['a', 'b'] as const, rows: [['1', '2'] as const] } },
    ];
    expectAgreement(pluginWith({ channels: [() => brokenChannel(webhook(), { setupFiles: files, setupGuide, troubleshooting: [{ id: 'x', problem: 'p', fix: 'f' }] })] }), false);
    // A plugin that still only has the deprecated plain-sentence steps is accepted too.
    expectAgreement(pluginWith({ channels: [() => brokenChannel(webhook(), { setupGuide: undefined, troubleshooting: undefined, setupSteps: ['Point the webhook here.'] })] }), false);
  });

  it.each(channelCases)('both reject a channel with %s', (_case, adapters) => {
    expectAgreement(pluginWith({ channels: adapters().map((a) => () => a) }), true);
  });

  const alert = () => alertFactories[0]!({ fetch: noFetch, mailTransport: () => ({ sendMail: noFetch, close: () => undefined }) });
  const alertCases: [string, () => AlertDeliveryAdapter[]][] = [
    ['a mixed-case kind', () => [{ ...alert(), kind: 'Slackish' }]],
    ['no events', () => [{ ...alert(), events: [] }]],
    ['an unknown event', () => [{ ...alert(), events: ['OPENED', 'EXPLODED' as never] }]],
    ['the same kind twice', () => [alert(), alert()]],
  ];
  it.each(alertCases)('both reject an alert destination with %s', (_case, adapters) => {
    expectAgreement(pluginWith({ alertDestinations: adapters().map((a) => () => a) }), true);
  });

  const provider = (): ProviderDefinition => providers[0]!;
  it.each([
    ['a lower-case kind', () => [{ ...provider(), kind: 'openai-ish' }]],
    ['the same kind twice', () => [provider(), provider()]],
  ] as [string, () => ProviderDefinition[]][])('both reject model providers with %s', (_case, defs) => {
    expectAgreement(pluginWith({ modelProviders: defs() }), true);
  });

  const driver = (): EmailDriverDefinition => emailDrivers[0]!;
  it.each([
    ['an upper-case name', () => [{ ...driver(), name: 'Resend2' }]],
    ['an underscore', () => [{ ...driver(), name: 'my_mail' }]],
    ['the same name twice', () => [driver(), driver()]],
  ] as [string, () => EmailDriverDefinition[]][])('both reject email drivers with %s', (_case, defs) => {
    expectAgreement(pluginWith({ emailDrivers: defs() }), true);
  });
});

/** The plugin envelope: the loader's shape check (validate.ts) and checkPlugin must give the same verdict. */
describe('SDK checkPlugin agrees with the loader on the plugin envelope', () => {
  const reserved = new Set(FIRST_PARTY_PLUGINS.map((p) => p.name));
  const envelope = (patch: Record<string, unknown>): Record<string, unknown> => ({ apiVersion: 1, name: '@acme/ocso-plugin', ...patch });
  const agree = (plugin: Record<string, unknown>, expectRejected: boolean) => {
    const loader = pluginShapeProblems(plugin, reserved);
    const sdk = checkPlugin(plugin);
    expect({ loaderRejects: loader.length > 0, sdkRejects: sdk.length > 0 }, `loader: ${loader.join(' | ') || 'ok'}; sdk: ${sdk.join(' | ') || 'ok'}`).toEqual({
      loaderRejects: expectRejected,
      sdkRejects: expectRejected,
    });
  };

  it.each([
    ['a minimal plugin', {}],
    ['a 214-character name', { name: 'a'.repeat(214) }],
    ['an unscoped name', { name: 'ocso-plugin-line' }],
    ['an extra top-level key', { version: '1.0.0', description: 'x' }],
    ['an empty contribution list', { channels: [] }],
  ] as [string, Record<string, unknown>][])('both accept %s', (_case, patch) => agree(envelope(patch), false));

  it.each([
    ['no apiVersion', { apiVersion: undefined }],
    ['apiVersion 2', { apiVersion: 2 }],
    ['apiVersion "1"', { apiVersion: '1' }],
    ['no name', { name: undefined }],
    ['a blank name', { name: '   ' }],
    ['a name with surrounding spaces', { name: ' @acme/x ' }],
    ['a 215-character name', { name: 'a'.repeat(215) }],
    ['a name in the reserved @ocso/ scope', { name: '@ocso/evil' }],
    ...FIRST_PARTY_PLUGINS.map((p) => [`the first-party name ${p.name}`, { name: p.name }] as [string, Record<string, unknown>]),
    ...['toolProviders', 'blobDrivers', 'secretsDrivers', 'queueDrivers', 'deploymentDrivers', 'auditStoreDrivers'].map((k) => [`internal-only ${k}`, { [k]: [] }] as [string, Record<string, unknown>]),
    ['channels that are not an array', { channels: {} }],
    ['a channel that is not a factory', { channels: ['x'] }],
    ['an alert destination that is not a factory', { alertDestinations: [{}] }],
    ['a model provider without create', { modelProviders: [{ kind: 'X_Y' }] }],
    ['an email driver without resolve', { emailDrivers: [{ name: 'x', create: () => null }] }],
  ] as [string, Record<string, unknown>][])('both reject %s', (_case, patch) => agree(envelope(patch), true));

  it('both reject a non-object export', () => {
    for (const value of [null, undefined, 'plugin', 1]) {
      expect(pluginShapeProblems(value, reserved).length).toBeGreaterThan(0);
      expect(checkPlugin(value).length).toBeGreaterThan(0);
    }
  });
});

describe('SDK constants and helpers match the internal ones', () => {
  it('uses the same patterns', () => {
    expect(Sdk.CHANNEL_KIND_PATTERN.source).toBe(INTERNAL_CHANNEL_KIND.source);
    expect(Sdk.PROVIDER_KIND_PATTERN.source).toBe(INTERNAL_PROVIDER_KIND.source);
    expect(Sdk.DESTINATION_KIND_PATTERN.source).toBe(INTERNAL_DESTINATION_KIND.source);
    expect(Sdk.DRIVER_NAME_PATTERN.source).toBe(INTERNAL_DRIVER_NAME.source);
    expect(Sdk.EMBED_PAGE_PREFIX).toBe(INTERNAL_EMBED_PAGE_PREFIX);
    expect(Sdk.REPLY_CONTEXT_MAX_KEYS).toBe(INTERNAL_REPLY_CONTEXT_MAX_KEYS);
    expect(Sdk.REPLY_CONTEXT_MAX_BYTES).toBe(INTERNAL_REPLY_CONTEXT_MAX_BYTES);
    expect(Sdk.ALERT_EVENTS).toEqual(INTERNAL_ALERT_EVENTS);
    expect(Sdk.PART_TYPES).toEqual(PART_TYPES);
    for (const kind of ['WHATSAPP', 'TWILIO_WHATSAPP', 'A_B_C']) expect(Sdk.defaultWebhookSegment(kind)).toBe(internalDefaultWebhookSegment(kind));
  });

  it('uses the same error categories', () => {
    expect(Sdk.ErrorCategory).toEqual(InternalErrorCategory);
    expect([...Sdk.RETRIABLE_CATEGORIES].sort()).toEqual([...INTERNAL_RETRIABLE].sort());
  });

  it('matches origins the same way', () => {
    const lists = [[], ['https://shop.example.com'], ['https://*.example.com'], ['https://*.example.com:8443', 'http://localhost:3000']];
    const origins = ['https://shop.example.com', 'https://a.b.example.com', 'https://example.com', 'https://Shop.example.com', 'http://localhost:3000', 'https://a.example.com:8443', 'null', 'garbage', 'https://shop.example.com/x'];
    for (const list of lists) for (const origin of origins) expect(Sdk.originAllowed(origin, list), `${origin} vs ${list.join(',')}`).toBe(internalOriginAllowed(origin, list));
  });

  it('reads choices and customer-renderable parts the same way', () => {
    const parts: Sdk.InteractionPart[] = [
      { type: 'STRUCTURED', schema: Sdk.CHOICES_SCHEMA, data: { text: 'Pick', options: [{ id: 'a', label: 'A' }] } },
      { type: 'STRUCTURED', schema: Sdk.CHOICES_SCHEMA, data: { text: 'Pick', options: [] } },
      { type: 'STRUCTURED', schema: Sdk.CHOICES_SCHEMA, data: { text: 'Pick', options: [{ id: 'a', label: 'x'.repeat(61) }] } },
      { type: 'STRUCTURED', schema: 'other', data: {} },
      { type: 'TEXT', text: 'hi' },
      { type: 'TOOL_RESULT', toolCallId: '1', toolName: 't', status: 'FAILED', summary: {} },
    ];
    for (const part of parts) {
      expect(Sdk.choicesOf(part)).toEqual(internalChoicesOf(part));
      expect(Sdk.isCustomerRenderable(part)).toBe(internalRenderable(part));
    }
  });
});
