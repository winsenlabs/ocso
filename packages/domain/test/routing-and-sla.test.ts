import { describe, expect, it } from 'vitest';
import {
  evaluateSla,
  formatSlaRemaining,
  ineligibilityReason,
  nextDeliveryStatus,
  pickupDueAt,
  selectAssignee,
  type ExecCandidate,
  type SlaPolicy,
} from '../src/index.js';

const exec = (over: Partial<ExecCandidate> & { userId: string }): ExecCandidate => ({
  availability: 'AVAILABLE',
  activeConversations: 0,
  maxConcurrent: 8,
  teamIds: ['t-cards'],
  skills: ['cards', 'emi'],
  languages: ['en'],
  lastAssignedAt: null,
  ...over,
});

describe('assignment strategy', () => {
  const req = { queueTeamIds: ['t-cards'], requiredSkills: ['cards'] };

  it('filters out unavailable, off-team, full and unskilled execs', () => {
    expect(ineligibilityReason(exec({ userId: 'a', availability: 'AWAY' }), req)).toBe('not_available');
    expect(ineligibilityReason(exec({ userId: 'b', teamIds: ['t-sales'] }), req)).toBe('not_in_queue_team');
    expect(ineligibilityReason(exec({ userId: 'c', activeConversations: 8 }), req)).toBe('at_capacity');
    expect(ineligibilityReason(exec({ userId: 'd', skills: ['emi'] }), req)).toBe('missing_skill');
    expect(ineligibilityReason(exec({ userId: 'e' }), { ...req, excludeUserIds: ['e'] })).toBe('excluded');
  });

  it('prefers least loaded exec, then longest idle', () => {
    const decision = selectAssignee(
      [
        exec({ userId: 'busy', activeConversations: 5 }),
        exec({ userId: 'idle-recent', activeConversations: 1, lastAssignedAt: new Date('2026-09-22T09:00:00Z') }),
        exec({ userId: 'idle-old', activeConversations: 1, lastAssignedAt: new Date('2026-09-22T08:00:00Z') }),
      ],
      req,
    );
    expect(decision?.userId).toBe('idle-old');
  });

  it('prefers the account owner and then language match', () => {
    const candidates = [exec({ userId: 'x' }), exec({ userId: 'owner', activeConversations: 6 }), exec({ userId: 'mr', languages: ['mr'] })];
    expect(selectAssignee(candidates, { ...req, accountOwnerUserId: 'owner' })?.userId).toBe('owner');
    expect(selectAssignee(candidates, { ...req, preferredLanguage: 'MR' })?.userId).toBe('mr');
  });

  it('returns null when nobody is eligible', () => {
    expect(selectAssignee([exec({ userId: 'a', availability: 'OFFLINE' })], req)).toBeNull();
  });
});

describe('SLA evaluation', () => {
  const policy: SlaPolicy = {
    firstHumanResponseSeconds: 900,
    pickupSecondsByPriority: { P1: 300 },
    resolutionSecondsByType: { SUPPORT: 14_400 },
    atRiskFraction: 0.75,
  };
  const start = new Date('2026-09-22T09:50:00Z');

  it('uses priority-specific pickup windows', () => {
    expect(pickupDueAt(policy, 'P1', start)?.toISOString()).toBe('2026-09-22T09:55:00.000Z');
    expect(pickupDueAt(policy, 'P3', start)?.toISOString()).toBe('2026-09-22T10:05:00.000Z');
  });

  it('moves OK → AT_RISK → BREACHED, and MET/MISSED once completed', () => {
    const due = new Date('2026-09-22T10:00:00Z');
    expect(evaluateSla(new Date('2026-09-22T09:51:00Z'), start, due, null, 0.75).state).toBe('OK');
    expect(evaluateSla(new Date('2026-09-22T09:58:00Z'), start, due, null, 0.75).state).toBe('AT_RISK');
    expect(evaluateSla(new Date('2026-09-22T10:01:38Z'), start, due, null, 0.75).state).toBe('BREACHED');
    expect(evaluateSla(new Date(), start, due, new Date('2026-09-22T09:59:00Z'), 0.75).state).toBe('MET');
    expect(evaluateSla(new Date(), start, due, new Date('2026-09-22T10:02:00Z'), 0.75).state).toBe('MISSED');
  });

  it('formats timers like the design', () => {
    expect(formatSlaRemaining(252_000)).toBe('04:12');
    expect(formatSlaRemaining(-98_000)).toBe('01:38');
    expect(formatSlaRemaining(100_800_000)).toBe('1d 04h');
  });
});

describe('delivery status ordering', () => {
  it('never moves backwards and FAILED is terminal', () => {
    expect(nextDeliveryStatus('READ', 'DELIVERED')).toBe('READ');
    expect(nextDeliveryStatus('SENT', 'READ')).toBe('READ');
    expect(nextDeliveryStatus('SENT', 'FAILED')).toBe('FAILED');
    expect(nextDeliveryStatus('FAILED', 'READ')).toBe('FAILED');
  });
});
