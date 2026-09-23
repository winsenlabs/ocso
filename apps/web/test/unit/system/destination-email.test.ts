import { describe, expect, it } from 'vitest';
import {
  activeVariant,
  buildDestinationConfig,
  configForm,
  initialConfigValues,
  receivesText,
  secretApplies,
} from '../../../components/alerts/destination-form';
// The real adapters: the web form must render whatever the delivery registry serves (contract test).
import { createDefaultDeliveryRegistry } from '../../../../../packages/alerts/src/index';

const kinds = createDefaultDeliveryRegistry({ fetch: async () => new Response('') }).describe();
const kind = (k: string) => kinds.find((x) => x.kind === k)!;
const fieldPaths = (schema: unknown, values: Record<string, string | boolean>) => activeVariant(configForm(schema), values).group.fields.map((f) => f.path);

describe('destination form renders from the adapter JSON Schema', () => {
  it('renders every registered kind without a per-kind table', () => {
    for (const k of kinds) {
      const form = configForm(k.configSchema);
      const built = buildDestinationConfig(form, initialConfigValues(form, null));
      const required = activeVariant(form, {}).group.fields.filter((f) => f.required).map((f) => f.path);
      expect(Object.keys(built.errors).sort(), k.kind).toEqual(required.sort());
    }
    expect(fieldPaths(kind('IN_APP').configSchema, {})).toEqual([]);
    expect(fieldPaths(kind('PAGERDUTY').configSchema, {})).toEqual(['region', 'component', 'group']);
    expect(fieldPaths(kind('SLACK').configSchema, {})).toEqual(['channelLabel']);
  });

  it('labels fields from the schema titles and omits blanks so adapter defaults apply', () => {
    const form = configForm(kind('PAGERDUTY').configSchema);
    expect(form.variantKey).toBeNull();
    expect(form.variants[0]!.group.fields.map((f) => f.label)).toEqual(['Region', 'Component', 'Group']);
    const values = initialConfigValues(form, null);
    expect(values).toEqual({ region: '', component: '', group: '' });
    expect(buildDestinationConfig(form, { ...values, component: 'payments' }).config).toEqual({ component: 'payments' });
    expect(initialConfigValues(form, { region: 'EU', component: 'payments' })).toMatchObject({ region: 'EU', component: 'payments' });
  });

  it('reports required fields before the request', () => {
    const form = configForm(kind('WEBHOOK').configSchema);
    expect(buildDestinationConfig(form, initialConfigValues(form, null)).errors).toEqual({ url: 'Required' });
    expect(buildDestinationConfig(form, { url: 'https://hooks.example.com/ocso' })).toEqual({ config: { url: 'https://hooks.example.com/ocso' }, errors: {} });
  });

  it('describes the events a kind receives', () => {
    expect(receivesText(kind('SLACK').events)).toBe('opened, resolved and reminders');
    expect(receivesText(kind('PAGERDUTY').events)).toBe('opened, acknowledged, resolved and reminders');
    expect(receivesText(kind('IN_APP').events)).toBe('opened');
  });
});

describe('email destination: deployment sender or own SMTP relay (oneOf variants)', () => {
  const email = kind('EMAIL');
  const form = configForm(email.configSchema);

  it('defaults new destinations to the deployment sender with recipients only and no password', () => {
    expect(form.variantKey).toBe('transport');
    expect(form.variantLabel).toBe('Send with');
    expect(form.variants.map((v) => v.value)).toEqual(['deployment', 'smtp']);
    const values = initialConfigValues(form, null);
    expect(values['transport']).toBe('deployment');
    expect(fieldPaths(email.configSchema, values)).toEqual(['to']);
    expect(secretApplies(email.secret, values)).toBe(false);
    expect(buildDestinationConfig(form, { ...values, to: 'a@x.io\nb@x.io', host: 'stale.example.com' }).config).toEqual({ transport: 'deployment', to: ['a@x.io', 'b@x.io'] });
  });

  it('shows and sends SMTP settings for the smtp transport', () => {
    const values = { ...initialConfigValues(form, null), transport: 'smtp', host: 'smtp.example.com', port: '465', from: 'ocso@example.com', to: 'a@x.io' };
    expect(fieldPaths(email.configSchema, values)).toEqual(['to', 'host', 'port', 'from', 'username', 'requireTLS']);
    expect(secretApplies(email.secret, values)).toBe(true);
    expect(buildDestinationConfig(form, values).config).toEqual({ transport: 'smtp', to: ['a@x.io'], host: 'smtp.example.com', port: 465, from: 'ocso@example.com', requireTLS: true });
  });

  it('opens a stored SMTP config (normalized by the API) on the smtp branch', () => {
    const stored = { transport: 'smtp', host: 'smtp.example.com', port: 587, secure: false, from: 'ocso@example.com', to: ['a@x.io'], requireTLS: false };
    const values = initialConfigValues(form, stored);
    expect(values).toMatchObject({ transport: 'smtp', host: 'smtp.example.com', port: '587', to: 'a@x.io', requireTLS: false });
    expect(activeVariant(form, values).value).toBe('smtp');
  });
});
