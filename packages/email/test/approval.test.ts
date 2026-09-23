import { describe, expect, it } from 'vitest';
import { approvalEmail } from '../src/index.js';

describe('approval email', () => {
  const base = { org: 'Meridian Bank', title: 'Take Maya live', objectLabel: 'Virtual agent', makerName: 'Lena Lead', checkerName: 'Anjali Rao', reason: 'Ready for customers', link: 'https://ocso.example/approvals?approval=abc' };

  it('asks the checker to decide, with the facts and a link', () => {
    const email = approvalEmail({ ...base, kind: 'REQUESTED', changes: 'status' });
    expect(email.subject).toBe('[OCSO] Approval needed: Take Maya live');
    expect(email.text).toContain('Lena Lead asked you to approve a change');
    expect(email.text).toContain('Ready for customers');
    expect(email.text).toContain('https://ocso.example/approvals?approval=abc');
    expect(email.html).toContain('Open in OCSO');
  });

  it('tells the maker the outcome', () => {
    expect(approvalEmail({ ...base, kind: 'APPROVED' }).subject).toBe('[OCSO] Approved: Take Maya live');
    expect(approvalEmail({ ...base, kind: 'REJECTED', reason: 'Not yet' }).text).toContain('rejected your change');
    expect(approvalEmail({ ...base, kind: 'BLOCKED' }).text).toContain('no longer passed validation');
    expect(approvalEmail({ ...base, kind: 'CHECKER_INVALID' }).subject).toBe('[OCSO] Needs a new checker: Take Maya live');
  });

  it('escapes what people typed', () => {
    const email = approvalEmail({ ...base, kind: 'REQUESTED', reason: '<script>alert(1)</script>' });
    expect(email.html).not.toContain('<script>');
  });
});
