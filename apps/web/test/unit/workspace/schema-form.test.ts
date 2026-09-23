import { describe, expect, it } from 'vitest';
import { buildArgs, humanizeName, schemaFields } from '../../../components/workspace/lib/schema-form';

/** Input schema of examples/mcp-bank-demo payments.reverse_transaction (as zod → JSON Schema publishes it). */
const REVERSE = {
  type: 'object',
  properties: {
    cif: { type: 'string', pattern: '^\\d{5,10}$', description: 'Customer information file number, e.g. 88214' },
    txnId: { type: 'string', pattern: '^TXN-\\d{4}-\\d{4}$' },
    amountMinor: { type: 'integer', exclusiveMinimum: 0, description: 'Amount to reverse in paise' },
    reason: { type: 'string', minLength: 3, maxLength: 500 },
    channel: { type: 'string', enum: ['SMS', 'EMAIL'] },
    notify: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    meta: { type: 'object', properties: { a: { type: 'string' } } },
  },
  required: ['cif', 'txnId', 'amountMinor', 'reason'],
};

describe('schema-driven tool form', () => {
  const fields = schemaFields(REVERSE);

  it('derives one field per property with kind, requiredness and hints', () => {
    expect(fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ['cif', 'text', true],
      ['txnId', 'text', true],
      ['amountMinor', 'integer', true],
      ['reason', 'text', true],
      ['channel', 'enum', false],
      ['notify', 'boolean', false],
      ['tags', 'list', false],
      ['meta', 'json', false],
    ]);
    expect(fields[2]?.label).toBe('Amount minor');
    expect(fields[0]?.description).toContain('88214');
    expect(fields[4]?.options).toEqual(['SMS', 'EMAIL']);
  });

  it('coerces values into arguments', () => {
    const { args, errors } = buildArgs(fields, {
      cif: '88214',
      txnId: 'TXN-8841-2290',
      amountMinor: '1,248,000',
      reason: 'duplicate EMI debit',
      channel: 'SMS',
      notify: true,
      tags: 'emi, duplicate',
      meta: '{"a":"b"}',
    });
    expect(errors).toEqual({});
    expect(args).toEqual({ cif: '88214', txnId: 'TXN-8841-2290', amountMinor: 1248000, reason: 'duplicate EMI debit', channel: 'SMS', notify: true, tags: ['emi', 'duplicate'], meta: { a: 'b' } });
  });

  it('reports what is clearly wrong before calling the API', () => {
    const { errors, args } = buildArgs(fields, { cif: 'abc', txnId: '', amountMinor: '12.5', reason: 'no', meta: '{oops' });
    expect(errors).toEqual({
      cif: 'Not in the expected format',
      txnId: 'Required',
      amountMinor: 'Enter a whole number',
      reason: 'At least 3 characters',
      meta: 'Enter valid JSON',
    });
    expect(args).toEqual({});
  });

  it('handles schemas without properties and odd names', () => {
    expect(schemaFields({ type: 'object' })).toEqual([]);
    expect(schemaFields(null)).toEqual([]);
    expect(humanizeName('txn_id')).toBe('Txn id');
    expect(humanizeName('cardLast4')).toBe('Card last4');
  });
});
