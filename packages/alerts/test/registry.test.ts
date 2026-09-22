import { describe, expect, it } from 'vitest';
import {
  AlertDeliveryRegistry,
  createDefaultDeliveryRegistry,
  createInAppAdapter,
  DESTINATION_EVENTS,
  DESTINATION_KINDS,
  destinationReceives,
} from '../src/index.js';
import { fakeFetch, fakeTransport, message } from './helpers.js';

describe('delivery registry', () => {
  const registry = createDefaultDeliveryRegistry({ fetch: fakeFetch().fetch, mailTransport: fakeTransport().factory });

  it('registers one adapter per destination kind', () => {
    expect(registry.kinds().sort()).toEqual([...DESTINATION_KINDS].sort());
    for (const kind of DESTINATION_KINDS) expect(registry.get(kind).kind).toBe(kind);
    expect(registry.find('SMS')).toBeUndefined();
    expect(() => registry.get('SMS' as never)).toThrow(/no alert delivery adapter/);
  });

  it('rejects duplicate registrations', () => {
    const r = new AlertDeliveryRegistry().register(createInAppAdapter());
    expect(() => r.register(createInAppAdapter())).toThrow(/already registered/);
  });

  it('rejects unknown config keys for every adapter (strict schemas)', () => {
    for (const kind of DESTINATION_KINDS) {
      expect(registry.get(kind).validateConfig({ unexpectedKey: true }).ok).toBe(false);
    }
  });

  it('in-app delivery is a no-op success (realtime goes through domain events)', async () => {
    const adapter = registry.get('IN_APP');
    expect(adapter.secret).toBeNull();
    expect(adapter.validateConfig({})).toEqual({ ok: true, config: {} });
    expect(await adapter.deliver(message(), {}, null)).toEqual({ ok: true, retriable: false });
  });

  it('declares which lifecycle events each kind receives', () => {
    expect(destinationReceives('PAGERDUTY', 'ACKNOWLEDGED')).toBe(true);
    expect(destinationReceives('WEBHOOK', 'RESOLVED')).toBe(true);
    expect(destinationReceives('SLACK', 'ACKNOWLEDGED')).toBe(false);
    expect(destinationReceives('IN_APP', 'RESOLVED')).toBe(false);
    for (const kind of DESTINATION_KINDS) expect(DESTINATION_EVENTS[kind]).toContain('OPENED');
  });
});
