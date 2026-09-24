import { describe, expect, it } from 'vitest';
import { ChannelRegistry, createMsTeamsAdapter, createSlackChannelAdapter, createWebChatAdapter, createWhatsAppAdapter, type ChannelAdapter, type ChannelKindDescriptor } from '../src/index.js';

/**
 * The kind-neutral `destination` setting (Ask OCSO over staff chat): offered, validated and read by the registry for
 * kinds whose descriptor sets `staffDestination`, never for others; the adapter never sees it.
 */

function plugin(kind: string, over: Partial<ChannelKindDescriptor> = {}, validate: ChannelAdapter['validateConfig'] = () => []): ChannelAdapter {
  const descriptor: ChannelKindDescriptor = {
    kind,
    label: kind,
    description: 'a workplace chat',
    mark: { code: 'WC', name: 'Workchat' },
    settingsSchema: { type: 'object', properties: { region: { type: 'string' } } },
    secrets: [],
    setupSteps: [],
    inboundWebhook: true,
    embeddable: false,
    ...over,
  };
  const reject = () => Promise.reject(new Error('not used'));
  return {
    kind,
    describe: () => descriptor,
    capabilities: () => createWebChatAdapter().capabilities(),
    validateConfig: validate,
    verifyRequest: () => ({ kind: 'verified' }),
    parseInbound: () => ({ messages: [], statuses: [], ignored: 0 }),
    fetchMedia: reject,
    render: () => [],
    send: reject,
  };
}

describe('staff destination', () => {
  it('Slack and Teams opt in; the other first-party kinds do not', () => {
    expect(createSlackChannelAdapter().describe().staffDestination).toBe(true);
    expect(createMsTeamsAdapter().describe().staffDestination).toBe(true);
    expect(createWhatsAppAdapter().describe().staffDestination).toBeUndefined();
    expect(createWebChatAdapter().describe().staffDestination).toBeUndefined();
  });

  it('adds the destination setting to a staff kind’s schema (first, default router) and to no other', () => {
    const registry = new ChannelRegistry().register(plugin('WORKCHAT', { staffDestination: true })).register(plugin('SMS'));
    const staff = registry.describe('WORKCHAT').settingsSchema as { properties: Record<string, { enum?: string[]; default?: string }> };
    expect(Object.keys(staff.properties)).toEqual(['destination', 'region']);
    expect(staff.properties['destination']).toMatchObject({ enum: ['router', 'ask_ocso'], default: 'router' });
    expect((registry.describe('SMS').settingsSchema as { properties: Record<string, unknown> }).properties['destination']).toBeUndefined();
  });

  it('reads the destination only for staff kinds, defaulting to router', () => {
    const registry = new ChannelRegistry().register(plugin('WORKCHAT', { staffDestination: true })).register(plugin('SMS'));
    expect(registry.destination('WORKCHAT', { destination: 'ask_ocso' })).toBe('ask_ocso');
    expect(registry.destination('WORKCHAT', {})).toBe('router');
    expect(registry.destination('WORKCHAT', { destination: 'somewhere' })).toBe('router');
    expect(registry.destination('SMS', { destination: 'ask_ocso' })).toBe('router');
    expect(registry.destination('UNKNOWN', { destination: 'ask_ocso' })).toBe('router');
  });

  it('validates the destination itself and hands the adapter its own settings without it', () => {
    const seen: unknown[] = [];
    const registry = new ChannelRegistry().register(
      plugin('WORKCHAT', { staffDestination: true }, (settings) => {
        seen.push(settings);
        return [];
      }),
    );
    expect(registry.validateConfig('WORKCHAT', { destination: 'ask_ocso', region: 'eu' }, {})).toEqual([]);
    expect(seen.at(-1)).toEqual({ region: 'eu' });
    expect(registry.validateConfig('WORKCHAT', { destination: 'nowhere' }, {})).toEqual(['settings.destination: must be one of router, ask_ocso']);
    expect(registry.validateConfig('NOPE', {}, {})).toEqual(['channel kind NOPE is not available']);
  });

  it('names the surface for threads and audit rows: the descriptor’s staffSurface, else the kind in lower case', () => {
    const registry = new ChannelRegistry().register(createSlackChannelAdapter()).register(createMsTeamsAdapter()).register(plugin('WORKCHAT', { staffDestination: true }));
    expect(registry.staffSurface('SLACK')).toBe('slack');
    expect(registry.staffSurface('MS_TEAMS')).toBe('teams');
    expect(registry.staffSurface('WORKCHAT')).toBe('workchat');
    expect(() => new ChannelRegistry().register(plugin('WORKCHAT', { staffDestination: true, staffSurface: 'Work Chat' }))).toThrow(/staffSurface/);
  });

  it('refuses a staff kind that declares destination itself, and a non-boolean flag', () => {
    const own = plugin('WORKCHAT', { staffDestination: true, settingsSchema: { type: 'object', properties: { destination: { type: 'string' } } } });
    expect(() => new ChannelRegistry().register(own)).toThrow(/belongs to OCSO/);
    expect(() => new ChannelRegistry().register(plugin('WORKCHAT', { staffDestination: 'yes' as never }))).toThrow(/must be a boolean/);
  });
});
