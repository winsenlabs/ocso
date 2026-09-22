import { describe, expect, it } from 'vitest';
import { createAjvValidator } from '../src/index.js';

describe('ajv validator', () => {
  const validate = createAjvValidator();
  const schema = { type: 'object', properties: { txnId: { type: 'string' }, amount: { type: 'number', minimum: 0 } }, required: ['txnId'], additionalProperties: false };
  it('accepts valid arguments and rejects invalid ones with readable errors', () => {
    expect(validate(schema, { txnId: 'T1', amount: 5 })).toEqual({ valid: true });
    const bad = validate(schema, { amount: -1, extra: true });
    expect(bad.valid).toBe(false);
    expect(!bad.valid && bad.errors.join(' ')).toMatch(/txnId|additional/);
  });
  it('fails closed on broken schemas', () => {
    expect(validate({ type: 'nonsense' }, {})).toEqual({ valid: false, errors: ['tool input schema is invalid'] });
  });
});
