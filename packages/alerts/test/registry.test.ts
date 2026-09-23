import { describe, expect, it } from 'vitest';
import {
  ALERT_EVENTS,
  AlertDeliveryRegistry,
  createDefaultDeliveryRegistry,
  createInAppAdapter,
  describeDestinationKind,
  secretRequirement,
  type AlertDeliveryAdapter,
} from '../src/index.js';
import { fakeFetch, fakeTransport, message } from './helpers.js';

const BUILT_IN = ['IN_APP', 'EMAIL', 'SLACK', 'TEAMS', 'WEBHOOK', 'PAGERDUTY'];

describe('delivery registry', () => {
  const registry = createDefaultDeliveryRegistry({ fetch: fakeFetch().fetch, mailTransport: fakeTransport().factory });

  it('registers one adapter per built-in destination kind; kinds are open strings', () => {
    expect(registry.kinds()).toEqual(BUILT_IN);
    for (const kind of registry.kinds()) expect(registry.get(kind).kind).toBe(kind);
    expect(registry.find('SMS')).toBeUndefined();
    expect(registry.has('SMS')).toBe(false);
    expect(() => registry.get('SMS')).toThrow(/no alert delivery adapter/);
  });

  it('registers a new kind without touching core', () => {
    const custom: AlertDeliveryAdapter = { ...createInAppAdapter(), kind: 'OPSGENIE', label: 'Opsgenie', events: ['OPENED', 'RESOLVED'] };
    const r = new AlertDeliveryRegistry().register(custom);
    expect(r.kinds()).toEqual(['OPSGENIE']);
    expect(r.receives('OPSGENIE', 'RESOLVED')).toBe(true);
    expect(r.describe()[0]).toMatchObject({ kind: 'OPSGENIE', label: 'Opsgenie', events: ['OPENED', 'RESOLVED'] });
  });

  it('rejects duplicate registrations, malformed kinds and unknown events', () => {
    const r = new AlertDeliveryRegistry().register(createInAppAdapter());
    expect(() => r.register(createInAppAdapter())).toThrow(/already registered/);
    expect(() => r.register({ ...createInAppAdapter(), kind: 'in-app' })).toThrow(/upper snake case/);
    expect(() => r.register({ ...createInAppAdapter(), kind: 'PAGER', events: [] })).toThrow(/known lifecycle events/);
    expect(() => r.register({ ...createInAppAdapter(), kind: 'PAGER', events: ['CLOSED' as never] })).toThrow(/known lifecycle events/);
  });

  it('rejects unknown config keys for every adapter (strict schemas)', () => {
    for (const kind of registry.kinds()) {
      expect(registry.get(kind).validateConfig({ unexpectedKey: true }).ok).toBe(false);
    }
  });

  it('in-app delivery is a no-op success (realtime goes through domain events)', async () => {
    const adapter = registry.get('IN_APP');
    expect(adapter.secret).toBeNull();
    expect(adapter.validateConfig({})).toEqual({ ok: true, config: {} });
    expect(await adapter.deliver(message(), {}, null)).toEqual({ ok: true, retriable: false });
  });

  it('each adapter declares which lifecycle events it receives', () => {
    expect(registry.receives('PAGERDUTY', 'ACKNOWLEDGED')).toBe(true);
    expect(registry.receives('WEBHOOK', 'RESOLVED')).toBe(true);
    expect(registry.receives('SLACK', 'ACKNOWLEDGED')).toBe(false);
    expect(registry.receives('IN_APP', 'RESOLVED')).toBe(false);
    expect(registry.receives('SMS', 'OPENED')).toBe(false);
    for (const kind of registry.kinds()) {
      expect(registry.get(kind).events).toContain('OPENED');
      for (const e of registry.get(kind).events) expect(ALERT_EVENTS).toContain(e);
    }
  });

  it('describes every kind for the web form without secrets or functions', () => {
    const kinds = registry.describe();
    expect(kinds.map((k) => k.kind)).toEqual(BUILT_IN);
    for (const k of kinds) {
      expect(k.label).not.toBe('');
      expect(k.description).not.toBe('');
      expect(k.configSchema).toMatchObject({ $schema: 'https://json-schema.org/draft/2020-12/schema' });
      expect(JSON.parse(JSON.stringify(k))).toEqual(k);
    }
    expect(describeDestinationKind(registry.get('SLACK')).secret).toEqual({ label: 'Incoming webhook URL', description: 'Slack incoming webhook URL', required: true, when: null });
    expect(describeDestinationKind(registry.get('EMAIL')).secret).toMatchObject({ label: 'SMTP password', required: false, when: { transport: 'smtp' } });
    // Email variants: one branch per transport, pinned by `transport`.
    const branches = (registry.get('EMAIL').configSchema['oneOf'] as Array<{ properties: Record<string, { const?: string }> }>).map((b) => b.properties['transport']?.const);
    expect(branches).toEqual(['deployment', 'smtp']);
  });

  it('applies a conditional secret only to matching configs', () => {
    const email = registry.get('EMAIL');
    const check = (c: unknown) => {
      const r = email.validateConfig(c);
      if (!r.ok) throw new Error(r.problems.join('; '));
      return secretRequirement(email, r.config);
    };
    expect(check({ transport: 'deployment', to: ['a@x.io'] })).toBeNull();
    expect(check({ transport: 'smtp', host: 'smtp.x.io', from: 'o@x.io', to: ['a@x.io'] })?.label).toBe('SMTP password');
    // Legacy SMTP config (no `transport`) still takes the password.
    expect(check({ host: 'smtp.x.io', from: 'o@x.io', to: ['a@x.io'] })?.label).toBe('SMTP password');
  });

  it('summarizes a validated config in one line', () => {
    const line = (kind: string, config: unknown) => {
      const adapter = registry.get(kind);
      const r = adapter.validateConfig(config);
      if (!r.ok) throw new Error(r.problems.join('; '));
      return adapter.summary(r.config);
    };
    expect(line('IN_APP', {})).toBe('OCSO inbox');
    expect(line('EMAIL', { transport: 'deployment', to: ['a@x.io', 'b@x.io'] })).toBe('a@x.io, b@x.io via deployment email');
    expect(line('EMAIL', { host: 'smtp.example.com', from: 'o@x.io', to: ['a@x.io'] })).toBe('a@x.io via smtp.example.com');
    expect(line('SLACK', { channelLabel: '#alerts-ops' })).toBe('#alerts-ops');
    expect(line('TEAMS', {})).toBe('webhook stored as a secret');
    expect(line('WEBHOOK', { url: 'https://hooks.example.com/ocso' })).toBe('https://hooks.example.com/ocso');
    expect(line('PAGERDUTY', { region: 'EU', component: 'payments' })).toBe('region EU · payments');
  });
});
