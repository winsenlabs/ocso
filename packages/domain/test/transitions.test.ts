import { describe, expect, it } from 'vitest';
import {
  CONTROL_STATES,
  ControlCommand,
  ControlState,
  InvalidTransitionError,
  TRANSITIONS,
  aiMaySendAutonomously,
  canTransition,
  controlModeOf,
  inboundStartsAiTurn,
  transition,
  type ControlCommand as Cmd,
  type TransitionContext,
} from '../src/index.js';

const S = ControlState;
const human = (userId = 'u1', assignedUserId: string | null = null): TransitionContext => ({
  actor: 'HUMAN',
  actorUserId: userId,
  assignedUserId,
});
const system: TransitionContext = { actor: 'SYSTEM' };
const agent: TransitionContext = { actor: 'AGENT' };

/** Every (from, command) pair the product relies on, with the expected target. */
const ALLOWED: Array<[ControlState, Cmd, TransitionContext, ControlState]> = [
  [S.AI_ACTIVE, 'REQUEST_ESCALATION', agent, S.ESCALATION_REQUESTED],
  [S.AI_ACTIVE, 'REQUEST_ESCALATION', system, S.ESCALATION_REQUESTED],
  [S.AI_RESUMING, 'REQUEST_ESCALATION', agent, S.ESCALATION_REQUESTED],
  [S.ESCALATION_REQUESTED, 'ROUTE_TO_QUEUE', system, S.WAITING_FOR_HUMAN],
  [S.WAITING_FOR_HUMAN, 'CLAIM', human('u1', null), S.HUMAN_ACTIVE],
  [S.WAITING_FOR_HUMAN, 'ACCEPT_ASSIGNMENT', human('u1', 'u1'), S.HUMAN_ACTIVE],
  [S.AI_ACTIVE, 'TAKE_OVER', human(), S.HUMAN_ACTIVE],
  [S.AI_RESUMING, 'TAKE_OVER', human(), S.HUMAN_ACTIVE],
  [S.ESCALATION_REQUESTED, 'TAKE_OVER', human(), S.HUMAN_ACTIVE],
  [S.HUMAN_ACTIVE, 'RELEASE_TO_QUEUE', human(), S.WAITING_FOR_HUMAN],
  [S.HUMAN_ACTIVE, 'RETURN_TO_AI', human(), S.AI_RESUMING],
  [S.AI_RESUMING, 'CANCEL_RETURN', human(), S.HUMAN_ACTIVE],
  [S.AI_RESUMING, 'RESUME_AI', system, S.AI_ACTIVE],
  [S.WAITING_FOR_HUMAN, 'CANCEL_ESCALATION', human(), S.AI_ACTIVE],
  [S.ESCALATION_REQUESTED, 'CANCEL_ESCALATION', system, S.AI_ACTIVE],
  [S.HUMAN_ACTIVE, 'RESOLVE', human(), S.RESOLVED],
  [S.AI_ACTIVE, 'RESOLVE', agent, S.RESOLVED],
  [S.WAITING_FOR_HUMAN, 'RESOLVE', system, S.RESOLVED],
  [S.RESOLVED, 'REOPEN', { actor: 'CUSTOMER', reopenedBy: 'CUSTOMER' }, S.AI_ACTIVE],
  [S.RESOLVED, 'REOPEN', { ...human(), reopenedBy: 'HUMAN' }, S.HUMAN_ACTIVE],
];

describe('conversation control transitions', () => {
  it.each(ALLOWED)('%s --%s--> target', (from, command, ctx, expected) => {
    expect(transition(from, command, ctx)).toBe(expected);
  });

  it('rejects every (state, command) pair not in the table', () => {
    const permissive: TransitionContext = { actor: 'SYSTEM', actorUserId: 'u1', reopenedBy: 'CUSTOMER' };
    for (const command of Object.values(ControlCommand)) {
      for (const from of CONTROL_STATES) {
        const listed = TRANSITIONS[command].from.includes(from);
        if (!listed) {
          expect(() => transition(from, command, permissive), `${command} from ${from}`).toThrow(
            InvalidTransitionError,
          );
        }
      }
    }
  });

  it('only allows the assigned user to accept an assignment', () => {
    expect(canTransition(S.WAITING_FOR_HUMAN, 'ACCEPT_ASSIGNMENT', human('u2', 'u1'))).toBe(false);
  });

  it('prevents claiming a conversation assigned to someone else', () => {
    expect(canTransition(S.WAITING_FOR_HUMAN, 'CLAIM', human('u2', 'u1'))).toBe(false);
    expect(canTransition(S.WAITING_FOR_HUMAN, 'CLAIM', human('u1', 'u1'))).toBe(true);
  });

  it('never lets the agent take over, claim or return control', () => {
    for (const command of ['TAKE_OVER', 'CLAIM', 'ACCEPT_ASSIGNMENT', 'RETURN_TO_AI', 'CANCEL_RETURN'] as const) {
      for (const from of CONTROL_STATES) expect(canTransition(from, command, agent)).toBe(false);
    }
  });

  it('requires an acting user for human commands', () => {
    expect(canTransition(S.AI_ACTIVE, 'TAKE_OVER', { actor: 'HUMAN' })).toBe(false);
  });

  it('allows autonomous AI output only in AI_ACTIVE', () => {
    const allowed = CONTROL_STATES.filter(aiMaySendAutonomously);
    expect(allowed).toEqual([S.AI_ACTIVE]);
  });

  it('starts AI turns on inbound only when AI owns or will own the conversation', () => {
    expect(CONTROL_STATES.filter(inboundStartsAiTurn)).toEqual([S.AI_ACTIVE, S.AI_RESUMING, S.RESOLVED]);
  });

  it('projects control mode from control state', () => {
    expect(controlModeOf(S.AI_RESUMING)).toBe('AI');
    expect(controlModeOf(S.WAITING_FOR_HUMAN)).toBe('WAITING_HUMAN');
    expect(controlModeOf(S.HUMAN_ACTIVE)).toBe('HUMAN');
    expect(controlModeOf(S.RESOLVED)).toBe('RESOLVED');
  });
});
