import type { AlertDeliveryAdapter, ChannelAdapter, ChannelKindDescriptor, EmailDriverDefinition, ProviderDefinition } from '../src/index.js';

/** A minimal valid channel adapter; override members to break it. */
export function channel(overrides: Partial<ChannelAdapter> = {}, descriptor: Partial<ChannelKindDescriptor> = {}): ChannelAdapter {
  const kind = overrides.kind ?? 'TEST_CHAT';
  const describe: ChannelKindDescriptor = {
    kind,
    label: 'Test chat',
    description: 'A channel for tests.',
    mark: { code: 'TC', name: 'Test chat' },
    settingsSchema: { type: 'object', properties: {} },
    secrets: [],
    setupSteps: [],
    inboundWebhook: true,
    embeddable: false,
    ...descriptor,
  };
  return {
    kind,
    describe: () => describe,
    capabilities: () => {
      throw new Error('not used');
    },
    validateConfig: () => [],
    verifyRequest: () => ({ kind: 'verified' }),
    parseInbound: () => ({ messages: [], statuses: [], ignored: 0 }),
    fetchMedia: () => Promise.reject(new Error('no media')),
    render: () => [],
    send: () => Promise.resolve({ ok: true, externalMessageId: 'x' }),
    ...overrides,
  };
}

export function destination(overrides: Partial<AlertDeliveryAdapter> = {}): AlertDeliveryAdapter {
  return {
    kind: 'TEST_HOOK',
    label: 'Test hook',
    description: 'Posts alerts nowhere.',
    events: ['OPENED', 'RESOLVED'],
    configSchema: { type: 'object' },
    secret: null,
    validateConfig: (config) => ({ ok: true, config }),
    validateSecret: () => [],
    summary: () => 'test',
    deliver: () => Promise.resolve({ ok: true, retriable: false }),
    ...overrides,
  };
}

const fakeSchema = { safeParse: (v: unknown) => ({ success: true, data: v }) } as unknown as ProviderDefinition['settingsSchema'];

export function provider(overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return {
    kind: 'TEST_LLM',
    label: 'Test LLM',
    mark: 'TL',
    cachingSummary: 'none',
    devOnly: false,
    settingsSchema: fakeSchema,
    credentialsSchema: fakeSchema,
    capabilities: () => {
      throw new Error('not used');
    },
    providerOptions: () => ({}),
    create: () => {
      throw new Error('not used');
    },
    ...overrides,
  };
}

export function emailDriver(overrides: Partial<EmailDriverDefinition> = {}): EmailDriverDefinition {
  return {
    name: 'test-mail',
    label: 'Test mail',
    delivers: true,
    resolve: () => ({}),
    create: (_options, sender) => ({ driver: 'test-mail', from: sender.from, send: () => Promise.resolve({ id: null }) }),
    ...overrides,
  };
}
