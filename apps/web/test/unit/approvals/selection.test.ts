import { describe, expect, it } from 'vitest';
import { ageLabel, fieldLabel, statusChip, valueText } from '../../../components/approvals/lib/labels';
import { decidedNotice, requestedNotice } from '../../../components/approvals/lib/notices';
import { bulkLabel, excluded, exclusionReason, selectAll, type SelectableRow } from '../../../components/approvals/lib/selection';

const ME = 'me';
const row = (id: string, over: Partial<SelectableRow> = {}): SelectableRow => ({ id, status: 'SUBMITTED', warnings: [], checker: { id: ME, name: 'Me' }, ...over });
const blocking = { code: 'edited_after_submission', message: 'The maker edited this proposal after submitting it.', blocksBulk: true };
const aged = { code: 'aged', message: 'Old.', blocksBulk: false };

describe('bulk selection', () => {
  const rows = [row('a'), row('b', { warnings: [blocking] }), row('c', { warnings: [aged] }), row('d', { checker: { id: 'other', name: 'Other' } }), row('e', { status: 'APPROVED' }), row('f', { warnings: [blocking] })];

  it('rows with a blocking warning are unselectable, with the reason; age does not block', () => {
    expect(exclusionReason(rows[1]!, ME)).toContain('edited this proposal');
    expect(exclusionReason(rows[2]!, ME)).toBeNull();
    expect(exclusionReason(rows[3]!, ME)).toBe('You are not the named checker');
    expect(exclusionReason(rows[4]!, ME)).toBe('Already decided');
  });

  it('select-all skips them and the bar counts the exclusions', () => {
    expect(selectAll(rows, ME)).toEqual(['a', 'c']);
    expect(excluded(rows, ME).map((r) => r.id)).toEqual(['b', 'f']);
    expect(bulkLabel(3, 2)).toBe('Approve 3 selected · 2 excluded');
    expect(bulkLabel(1, 0)).toBe('Approve 1 selected');
  });
});

describe('labels and notices', () => {
  it('labels fields, values, ages and statuses', () => {
    expect(fieldLabel('modelProfile')).toBe('model profile');
    expect(fieldLabel('businessHours.timezone')).toBe('business hours › timezone');
    expect(valueText(null)).toBe('—');
    expect(valueText(['Cards', 'Loans'])).toBe('Cards, Loans');
    expect(valueText({ a: 1 })).toBe('{"a":1}');
    expect(ageLabel(90)).toBe('2 min');
    expect(ageLabel(7200)).toBe('2 h');
    expect(ageLabel(3 * 86_400)).toBe('3 d');
    expect(statusChip({ status: 'APPROVED', activating: true }).label).toBe('activating');
    expect(statusChip({ status: 'APPROVED', activating: false, bootstrap: true }).label).toBe('approved (bootstrap)');
  });

  it('tells the maker the outcome and the checker what waits', () => {
    const decided = { proposalId: 'p', objectKind: 'agent', decision: 'APPROVED', checkerId: 'c', makerId: ME };
    expect(decidedNotice('e1', decided, ME)).toMatchObject({ tone: 'good', href: '/approvals?box=sent&approval=p' });
    expect(decidedNotice('e1', decided, 'someone-else')).toBeNull();
    expect(decidedNotice('e1', { ...decided, decision: 'WITHDRAWN' }, ME)).toBeNull();
    expect(requestedNotice({ proposalId: 'p', makerId: 'm', checkerId: ME }, ME, 3)?.text).toBe('3 changes are waiting for your approval.');
    expect(requestedNotice({ proposalId: 'p', makerId: 'm', checkerId: 'x' }, ME, 1)).toBeNull();
  });
});
