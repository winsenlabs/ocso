import { describe, expect, it } from 'vitest';
import {
  CHOICES_SCHEMA,
  ErrorCategory,
  OCSO_PLUGIN_API_VERSION,
  choicesOf,
  defaultWebhookSegment,
  definePlugin,
  delivered,
  failed,
  isCustomerRenderable,
  isPluginError,
  originAllowed,
  pluginError,
  renderChoicesAsText,
} from '../src/index.js';

describe('pluginError', () => {
  it('returns an Error with a non-enumerable ocsoError marker', () => {
    const error = pluginError('authentication', 'token_expired', 'The token has expired', { at: 'identify' });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('The token has expired');
    expect(error.name).toBe('OcsoPluginError');
    expect(error.ocsoError).toEqual({ category: 'authentication', code: 'token_expired', details: { at: 'identify' } });
    expect(Object.keys(error)).not.toContain('ocsoError');
    expect(JSON.stringify(error)).not.toContain('token_expired');
    expect(Object.isFrozen(error.ocsoError)).toBe(true);
    expect(isPluginError(error)).toBe(true);
  });

  it('omits details when none are given', () => {
    expect(pluginError(ErrorCategory.VALIDATION, 'bad', 'Bad').ocsoError).toEqual({ category: 'validation', code: 'bad' });
  });

  it('refuses unknown categories and empty codes', () => {
    expect(() => pluginError('nope' as never, 'x', 'y')).toThrow(TypeError);
    expect(() => pluginError('internal', '', 'y')).toThrow(TypeError);
  });

  it('recognizes the marker by shape, not by class (another copy of the SDK)', () => {
    const foreign = Object.assign(new Error('x'), { ocsoError: { category: 'not_found', code: 'thing_not_found' } });
    expect(isPluginError(foreign)).toBe(true);
    expect(isPluginError(Object.assign(new Error('x'), { ocsoError: { category: 'weird', code: 'x' } }))).toBe(false);
    expect(isPluginError(Object.assign(new Error('x'), { ocsoError: { category: 'internal', code: '' } }))).toBe(false);
    expect(isPluginError(Object.assign(new Error('x'), { ocsoError: { category: 'internal', code: 'c', details: 'str' } }))).toBe(false);
    expect(isPluginError({ ocsoError: { category: 'internal', code: 'c' } })).toBe(false);
    expect(isPluginError(new Error('plain'))).toBe(false);
    expect(isPluginError(undefined)).toBe(false);
  });
});

describe('originAllowed', () => {
  it('matches exact origins and one wildcard label', () => {
    expect(originAllowed('https://shop.example.com', ['https://shop.example.com'])).toBe(true);
    expect(originAllowed('https://a.example.com', ['https://*.example.com'])).toBe(true);
    expect(originAllowed('https://a.b.example.com', ['https://*.example.com'])).toBe(true);
    expect(originAllowed('https://example.com', ['https://*.example.com'])).toBe(false);
    expect(originAllowed('http://a.example.com', ['https://*.example.com'])).toBe(false);
    expect(originAllowed('https://a.example.com:8443', ['https://*.example.com'])).toBe(false);
    expect(originAllowed('https://a.example.com:8443', ['https://*.example.com:8443'])).toBe(true);
    expect(originAllowed('https://evilexample.com', ['https://*.example.com'])).toBe(false);
  });

  it('rejects malformed, opaque and path-carrying origins', () => {
    expect(originAllowed('not a url', ['*'])).toBe(false);
    expect(originAllowed('null', ['null'])).toBe(false);
    expect(originAllowed('https://Shop.example.com', ['https://shop.example.com'])).toBe(true);
    expect(originAllowed('https://shop.example.com/path', ['https://shop.example.com'])).toBe(false);
    expect(originAllowed('https://shop.example.com', [])).toBe(false);
  });
});

describe('small helpers', () => {
  it('reads choice questions and renders them as text', () => {
    const data = { text: 'Which product?', options: [{ id: 'c', label: 'Cards' }, { id: 'l', label: 'Loans' }] };
    const part = { type: 'STRUCTURED' as const, schema: CHOICES_SCHEMA, data };
    expect(choicesOf(part)).toEqual(data);
    expect(choicesOf({ ...part, data: { text: 'x', options: [] } })).toBeNull();
    expect(choicesOf({ ...part, data: { text: 'x', options: [{ id: 'a', label: 'x'.repeat(61) }] } })).toBeNull();
    expect(choicesOf({ type: 'TEXT', text: 'hi' })).toBeNull();
    expect(renderChoicesAsText(data)).toBe('Which product?\n\n1. Cards\n2. Loans');
  });

  it('keeps tool results away from customers', () => {
    expect(isCustomerRenderable({ type: 'TEXT', text: 'hi' })).toBe(true);
    expect(isCustomerRenderable({ type: 'TOOL_RESULT', toolCallId: '1', toolName: 't', status: 'SUCCEEDED', summary: {} })).toBe(false);
  });

  it('derives webhook segments and delivery results', () => {
    expect(defaultWebhookSegment('TWILIO_WHATSAPP')).toBe('twilio-whatsapp');
    expect(delivered()).toEqual({ ok: true, retriable: false });
    expect(delivered('m1')).toEqual({ ok: true, retriable: false, externalId: 'm1' });
    expect(failed(true, 'timeout')).toEqual({ ok: false, retriable: true, error: 'timeout' });
  });

  it('definePlugin returns the plugin unchanged', () => {
    const plugin = { apiVersion: OCSO_PLUGIN_API_VERSION, name: 'x' } as const;
    expect(definePlugin(plugin)).toBe(plugin);
  });
});
