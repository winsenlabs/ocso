import { describe, expect, it } from 'vitest';
import { permissionsForRole, type Role } from '@ocso/auth';
import type { ControlState } from '@ocso/domain';
import { controlView } from '../../../components/workspace/lib/control';

const ME = 'user-me';
const OTHER = 'user-other';
const view = (role: Role, controlState: ControlState, assignedUserId: string | null = null, handoffStatus: string | null = null) =>
  controlView({ controlState, assignedUserId, handoffStatus, meId: ME, permissions: new Set(permissionsForRole(role)) });

describe('workspace actions per control state (ADR-005, docs/archive/specs/09 §4)', () => {
  it('lets an exec take over an AI conversation but not write to the customer', () => {
    expect(view('SERVICE', 'AI_ACTIVE')).toEqual({ actions: ['take-over'], canCompose: false, holdsIt: false, offeredToMe: false });
  });

  it('offers Claim on open pickup and Accept/Decline on an auto-assign offer to me', () => {
    expect(view('SERVICE', 'WAITING_FOR_HUMAN').actions).toEqual(['claim']);
    const offered = view('SERVICE', 'WAITING_FOR_HUMAN', ME, 'OFFERED');
    expect(offered.actions).toEqual(['accept', 'decline']);
    expect(offered.offeredToMe).toBe(true);
    // Offered to someone else: nothing to do here.
    expect(view('SERVICE', 'WAITING_FOR_HUMAN', OTHER, 'OFFERED').actions).toEqual([]);
  });

  it('gives the holder return, transfer and resolve plus the composer', () => {
    const held = view('SERVICE', 'HUMAN_ACTIVE', ME);
    expect(held.actions).toEqual(['return-to-ai', 'transfer', 'resolve']);
    expect(held.canCompose).toBe(true);
    expect(held.holdsIt).toBe(true);
  });

  it('locks the composer for an exec watching a colleague’s conversation', () => {
    expect(view('SERVICE', 'HUMAN_ACTIVE', OTHER)).toMatchObject({ actions: [], canCompose: false });
  });

  it('lets a lead with assign rights act on a conversation someone else holds', () => {
    const lead = view('HEAD', 'HUMAN_ACTIVE', OTHER);
    expect(lead.actions).toEqual(['return-to-ai', 'transfer', 'resolve']);
    expect(lead.canCompose).toBe(true);
    expect(lead.holdsIt).toBe(false);
  });

  it('offers Cancel return while the AI resumes, and Reopen once resolved', () => {
    expect(view('SERVICE', 'AI_RESUMING', ME).actions).toEqual(['cancel-return']);
    expect(view('SERVICE', 'AI_RESUMING', OTHER).actions).toEqual(['take-over']);
    expect(view('SERVICE', 'RESOLVED', ME).actions).toEqual(['reopen']);
  });

  it('gives a Tech admin nothing (no conversation permissions)', () => {
    for (const state of ['AI_ACTIVE', 'WAITING_FOR_HUMAN', 'HUMAN_ACTIVE', 'RESOLVED'] as const) {
      expect(view('TECH', state, ME)).toMatchObject({ actions: [], canCompose: false });
    }
  });
});
