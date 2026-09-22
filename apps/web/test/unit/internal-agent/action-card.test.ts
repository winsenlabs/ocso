import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ActionCard } from '../../../components/internal-agent/action-card';
import type { PendingAction } from '../../../components/internal-agent/types';
import type { ActionDecision } from '../../../lib/actions/internal-agent';

vi.mock('../../../lib/actions/internal-agent', () => ({ confirmAskOcsoAction: vi.fn(), rejectAskOcsoAction: vi.fn() }));

/** Confirmation card states (docs/12 §4): pending → confirmed / rejected / expired / decided elsewhere. */

const action: PendingAction = {
  id: '0199aaaa-0000-7000-8000-000000000001',
  tool: 'set_agent_status',
  risk: 'HIGH_WRITE',
  description: 'Pause virtual agent Maya. New customer messages will wait for humans.',
  expiresAt: '2026-09-22T10:15:00.000Z',
  changes: [{ label: 'Maya · status', before: 'LIVE', after: 'PAUSED' }],
};

const render = (a: PendingAction, decision?: ActionDecision) =>
  renderToStaticMarkup(createElement(ActionCard, { action: a, decision, onDecided: () => {}, userName: 'Leo Lead' }));

describe('ActionCard', () => {
  it('asks for confirmation and shows before → after', () => {
    const html = render(action);
    expect(html).toContain('>Confirm change</button>');
    expect(html).toContain('>Reject</button>');
    expect(html).toContain('LIVE → <b>PAUSED</b>');
  });

  it('after confirming, shows the result instead of the buttons', () => {
    const html = render(action, { ok: true, status: 'EXECUTED', links: [{ label: 'Maya', detail: 'status PAUSED', href: '/agents/x' }], table: null });
    expect(html).not.toContain('Confirm change</button>');
    expect(html).toContain('confirmed');
    expect(html).toContain('recorded in the audit log');
    expect(html).toContain('href="/agents/x"');
  });

  it('after rejecting, says nothing changed', () => {
    expect(render(action, { ok: true, status: 'REJECTED' })).toContain('Nothing was changed.');
  });

  it('shows history status: an expired or executed proposal never offers Confirm again', () => {
    expect(render({ ...action, status: 'EXPIRED' })).not.toContain('Confirm change</button>');
    expect(render({ ...action, status: 'EXECUTED' })).toContain('Applied.');
  });

  it('keeps the buttons and explains a refusal (e.g. permission re-check at confirm time)', () => {
    const html = render(action, { ok: false, message: 'Not allowed for your role: agents.manage: your role does not allow this', settled: null });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Not allowed for your role');
    expect(html).toContain('>Confirm change</button>');
  });

  it('reports an action decided elsewhere without buttons', () => {
    const html = render(action, { ok: false, message: 'Action is already executed.', settled: 'DECIDED' });
    expect(html).toContain('Action is already executed.');
    expect(html).not.toContain('Confirm change</button>');
  });
});
