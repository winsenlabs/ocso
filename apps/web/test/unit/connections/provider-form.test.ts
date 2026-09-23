import { describe, expect, it } from 'vitest';
import type { FieldDescriptor } from '../../../lib/api/models';
import { credentialsFromValues, initialFieldValues, settingsFromValues } from '../../../components/connections/models/provider-form';

const d = (over: Partial<FieldDescriptor> & Pick<FieldDescriptor, 'name' | 'type'>): FieldDescriptor => ({ label: over.name, required: false, secret: false, ...over });

const SETTINGS: FieldDescriptor[] = [
  d({ name: 'latencyMs', type: 'integer', default: 300, min: 0, max: 30_000 }),
  d({ name: 'simulateError', type: 'enum', options: ['RATE_LIMITED', 'UNAVAILABLE'] }),
  d({ name: 'storeResponses', type: 'boolean', default: false }),
  d({ name: 'explicitCacheBreakpoints', type: 'boolean' }),
  d({ name: 'capabilityOverrides', type: 'json' }),
  d({ name: 'baseURL', type: 'url' }),
];

describe('provider settings from descriptors', () => {
  it('starts from stored settings, else descriptor defaults', () => {
    expect(initialFieldValues(SETTINGS, null)).toEqual({ latencyMs: '300', simulateError: '', storeResponses: false, explicitCacheBreakpoints: '', capabilityOverrides: '', baseURL: '' });
    const stored = initialFieldValues(SETTINGS, { latencyMs: 0, explicitCacheBreakpoints: true, capabilityOverrides: { m: { imageInput: true } } });
    expect(stored['latencyMs']).toBe('0');
    expect(stored['explicitCacheBreakpoints']).toBe('true');
    expect(JSON.parse(String(stored['capabilityOverrides']))).toEqual({ m: { imageInput: true } });
  });

  it('builds the settings object and leaves blank optional fields to the adapter', () => {
    const values = { latencyMs: '0', simulateError: 'RATE_LIMITED', storeResponses: true, explicitCacheBreakpoints: '', capabilityOverrides: '', baseURL: '  ' };
    expect(settingsFromValues(SETTINGS, values)).toEqual({ settings: { latencyMs: 0, simulateError: 'RATE_LIMITED', storeResponses: true }, errors: {} });
  });

  it('rejects out-of-range numbers, bad JSON, unknown options and missing required values', () => {
    const required = [...SETTINGS, d({ name: 'resourceName', type: 'string', required: true })];
    const r = settingsFromValues(required, { latencyMs: '1.5', simulateError: 'NOPE', capabilityOverrides: '{', resourceName: '' });
    expect(r.errors).toEqual({ latencyMs: 'Enter a whole number', simulateError: 'One of RATE_LIMITED, UNAVAILABLE', capabilityOverrides: 'Enter valid JSON', resourceName: 'Required' });
  });
});

describe('write-only credentials', () => {
  const CREDS = [d({ name: 'apiKey', type: 'string', required: true, secret: true }), d({ name: 'sessionToken', type: 'string', secret: true })];

  it('sends typed values on create and requires required ones', () => {
    expect(credentialsFromValues(CREDS, { apiKey: 'sk-1' }, { editing: false, removed: new Set(), stored: new Set() })).toEqual({ credentials: { apiKey: 'sk-1' }, errors: {} });
    expect(credentialsFromValues(CREDS, {}, { editing: false, removed: new Set(), stored: new Set() }).errors).toEqual({ apiKey: 'Required' });
  });

  it('on edit, blank keeps, a value rotates and remove sends null (never for required ones)', () => {
    const stored = new Set(['apiKey', 'sessionToken']);
    expect(credentialsFromValues(CREDS, {}, { editing: true, removed: new Set(), stored })).toEqual({ credentials: {}, errors: {} });
    expect(credentialsFromValues(CREDS, { apiKey: 'new' }, { editing: true, removed: new Set(['sessionToken']), stored })).toEqual({ credentials: { apiKey: 'new', sessionToken: null }, errors: {} });
    expect(credentialsFromValues(CREDS, {}, { editing: true, removed: new Set(['apiKey']), stored }).errors['apiKey']).toContain('replacement');
  });
});
