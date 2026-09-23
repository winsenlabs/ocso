import { describe, expect, it } from 'vitest';
import { approvalsHref, parseApprovalsParams, toApiQuery } from '../../../components/approvals/approvals-meta';

const ID = '01a0cd12-87fc-71e6-85ff-7b598bcdf97b';

describe('approvals URL model', () => {
  it('defaults to Awaiting me and drops junk', () => {
    expect(parseApprovalsParams({})).toEqual({ box: 'AWAITING_ME', kind: undefined, needsChecker: undefined, approval: undefined, before: undefined, beforeId: undefined });
    expect(parseApprovalsParams({ box: 'nope', kind: 'DROP TABLE', approval: 'not-a-uuid', needs: 'x' })).toMatchObject({ box: 'AWAITING_ME', kind: undefined, approval: undefined, needsChecker: undefined });
  });

  it('requires UUIDs and a complete, well-formed cursor', () => {
    expect(parseApprovalsParams({ approval: ID }).approval).toBe(ID);
    expect(parseApprovalsParams({ before: '2026-09-23T10:00:00.000Z' })).toMatchObject({ before: undefined, beforeId: undefined });
    expect(parseApprovalsParams({ before: 'yesterday', beforeId: ID })).toMatchObject({ before: undefined });
    expect(parseApprovalsParams({ before: '2026-09-23T10:00:00.000Z', beforeId: ID })).toMatchObject({ before: '2026-09-23T10:00:00.000Z', beforeId: ID });
  });

  it('builds URLs without defaults and round-trips', () => {
    expect(approvalsHref({ box: 'AWAITING_ME' })).toBe('/approvals');
    const params = { box: 'OPEN' as const, kind: 'agent', needsChecker: true, approval: ID };
    const href = approvalsHref(params);
    expect(href).toBe(`/approvals?box=open&kind=agent&needs=checker&approval=${ID}`);
    const back = parseApprovalsParams(Object.fromEntries(new URL(href, 'http://x').searchParams));
    expect(back).toMatchObject(params);
  });

  it('maps to the API query (the open drawer is not part of it)', () => {
    expect(toApiQuery({ box: 'SENT_BY_ME', kind: 'agent', approval: ID })).toEqual({ box: 'SENT_BY_ME', objectKind: 'agent', needsChecker: undefined, before: undefined, beforeId: undefined, limit: 50 });
  });
});
