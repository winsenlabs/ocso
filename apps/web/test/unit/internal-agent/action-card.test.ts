import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ActionCard, orderedCheckers, statusOf } from '../../../components/internal-agent/action-card';
import { decisionFailure, fromAnswer, readActionAnswer, type ActionDecision } from '../../../components/internal-agent/decisions';
import { toActionCard, type ActionCardData, type ActionPart, type PendingAction } from '../../../components/internal-agent/types';
import { ApiError } from '../../../lib/api/errors';

vi.mock('../../../lib/actions/internal-agent', () => ({ confirmAskOcsoAction: vi.fn(), rejectAskOcsoAction: vi.fn() }));

/** Ask OCSO cards (PM/research/12 §5): direct / stop / governed, and every settled state. */

const FUTURE = new Date(Date.now() + 15 * 60_000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();
const AGENT = '0199aaaa-0000-7000-8000-0000000000b2';

const direct: ActionCardData = {
  id: '0199aaaa-0000-7000-8000-000000000001',
  tool: 'agents.update_agent',
  title: 'Rename Maya to Maya (cards)',
  summary: 'Only the display name changes.',
  kind: 'direct',
  object: { kind: 'agent', id: AGENT, name: 'Maya', href: `/agents/${AGENT}` },
  changes: [{ label: 'Name', before: 'Maya', after: 'Maya (cards)' }],
  warnings: [],
  expiresAt: FUTURE,
  status: 'PENDING',
};

const stop: ActionCardData = { ...direct, tool: 'agents.set_agent_status', title: 'Pause Maya', summary: 'New customer messages wait for humans.', kind: 'stop', changes: [{ label: 'Status', before: 'LIVE', after: 'PAUSED' }] };

const governed: ActionCardData = {
  ...direct,
  tool: 'agents.update_agent',
  title: "Raise Maya's refund limit",
  kind: 'governed',
  changes: [
    { label: 'Refund limit', before: '₹5,000', after: '₹10,000' },
    { label: 'Escalation note', before: null, after: 'Above ₹10,000 always hand off' },
  ],
  warnings: ["You are about to raise an agent's authority."],
  approval: {
    objectKind: 'agent',
    checkers: [
      { id: '0199aaaa-0000-7000-8000-0000000000c1', name: 'Asha Rao', role: 'Head', suggested: false },
      { id: '0199aaaa-0000-7000-8000-0000000000c2', name: 'Tomas Shetty', role: 'Tech', suggested: true },
    ],
    noEligibleChecker: false,
    uiHref: `/agents/${AGENT}`,
  },
};

const legacy: PendingAction = {
  id: '0199aaaa-0000-7000-8000-000000000009',
  tool: 'set_agent_status',
  risk: 'HIGH_WRITE',
  description: 'Pause virtual agent Maya. New customer messages will wait for humans.',
  expiresAt: FUTURE,
  changes: [{ label: 'Maya · status', before: 'LIVE', after: 'PAUSED' }],
};

const render = (a: ActionPart, decision?: ActionDecision) => renderToStaticMarkup(createElement(ActionCard, { action: a, decision, onDecided: () => {}, userName: 'Leo Lead' }));

describe('ActionCard · pending', () => {
  it('direct: title, object link, before → after table, Applies now, Confirm / Cancel', () => {
    const html = render(direct);
    expect(html).toContain('>Applies now</span>');
    expect(html).toContain('Rename Maya to Maya (cards)');
    expect(html).toContain(`<a href="/agents/${AGENT}">Maya</a>`);
    expect(html).toContain('<caption class="sr-only">What will change</caption>');
    expect(html).toContain('<th scope="row">Name</th><td>Maya</td><td><b>Maya (cards)</b></td>');
    expect(html).toContain('>Confirm change</button>');
    expect(html).toContain('>Cancel</button>');
    expect(html).toContain('attributed to Leo Lead');
    // Only governed cards ask who approves.
    expect(html).not.toContain('Who approves');
  });

  it('stop: a Stop badge and Confirm stop, no approval', () => {
    const html = render(stop);
    expect(html).toContain('data-kind="stop"');
    expect(html).toContain('>Stop</span>');
    expect(html).toContain('>Confirm stop</button>');
    expect(html).not.toContain('Who approves');
  });

  it('governed: checker picker with the suggested checker first and selected, a required reason, warnings, never bootstrap', () => {
    const html = render(governed);
    expect(html).toContain('>Needs approval</span>');
    expect(html).toContain('>Who approves</label>');
    expect(html.indexOf('Tomas Shetty · Tech · suggested')).toBeLessThan(html.indexOf('Asha Rao · Head'));
    expect(html).toMatch(/<option value="0199aaaa-0000-7000-8000-0000000000c2" selected="">/);
    expect(html).toMatch(/<textarea[^>]*required=""/);
    expect(html).toContain('<ul class="ia-warnings" aria-label="Before you confirm"><li>You are about to raise an agent&#x27;s authority.</li></ul>');
    expect(html).toContain('<td class="ia-none">—</td>');
    expect(html).toContain('>Send for approval</button>');
    expect(html.toLowerCase()).not.toContain('bootstrap');
    expect(html.toLowerCase()).not.toContain('approve it myself');
  });

  it('governed with nobody eligible: says so, links to the page, and offers only Cancel', () => {
    const nobodyLine = 'Nobody else can approve this; open it in OCSO to continue.';
    const html = render({ ...governed, warnings: [...governed.warnings, nobodyLine], approval: { ...governed.approval!, checkers: [], noEligibleChecker: true } });
    // Said once (the bold note), not again in the warnings the runtime also sends; other warnings stay.
    expect(html.split(nobodyLine)).toHaveLength(2);
    expect(html).toContain("<li>You are about to raise an agent&#x27;s authority.</li>");
    expect(html).toContain(`href="/agents/${AGENT}"`);
    expect(html).not.toContain('Send for approval</button>');
    expect(html).toContain('>Cancel</button>');
  });

  it('never links an object off-site', () => {
    const html = render({ ...direct, object: { kind: 'agent', id: AGENT, name: 'Evil', href: 'https://evil.test/x' } });
    expect(html).not.toContain('evil.test');
    expect(html).toContain('<span>Evil</span>');
  });

  it('keeps the buttons and explains a refusal (e.g. the permission re-check at confirm time)', () => {
    const html = render(direct, { ok: false, message: 'Not allowed for your role: agents.manage', settled: null });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Not allowed for your role');
    expect(html).toContain('>Confirm change</button>');
  });

  it('a direct card the route turned governed comes back asking who approves, suggested checker preselected', () => {
    const html = render(direct, { ok: true, card: { ...governed, id: direct.id, status: 'PENDING' } });
    expect(html).toContain('>Needs approval</span>');
    expect(html).toMatch(/<option value="0199aaaa-0000-7000-8000-0000000000c2" selected="">/);
    expect(html).toContain('>Send for approval</button>');
  });

  it('marks the reason field when the server rejected it', () => {
    const html = render(governed, { ok: false, message: 'Give a reason of at least 3 characters.', settled: null, field: 'reason' });
    expect(html).toMatch(/<textarea[^>]*aria-invalid="true"[^>]*aria-describedby="[^"]+-err"/);
    expect(html).toContain('Give a reason of at least 3 characters.');
  });
});

describe('ActionCard · settled', () => {
  it('executed: the result message and link, no buttons', () => {
    const html = render(direct, { ok: true, card: { ...direct, status: 'EXECUTED', result: { message: 'Maya is now called Maya (cards).', href: `/agents/${AGENT}` } } });
    expect(html).not.toContain('Confirm change</button>');
    expect(html).toContain('>done</span>');
    expect(html).toContain('Maya is now called Maya (cards).');
    expect(html).toContain('Open →');
  });

  it('submitted: says it went for approval and links the proposal', () => {
    const html = render(governed, { ok: true, card: { ...governed, status: 'SUBMITTED', result: { message: 'Sent to Tomas Shetty for approval.', href: '/approvals?id=p1', proposalId: 'p1' } } });
    expect(html).toContain('>sent for approval</span>');
    expect(html).toContain('Sent to Tomas Shetty for approval.');
    expect(html).toContain('href="/approvals?id=p1"');
    expect(html).toContain('Open the proposal →');
    expect(html).not.toContain('Who approves');
  });

  it('cancelled, expired, stale and failed never offer Confirm again', () => {
    for (const status of ['REJECTED', 'EXPIRED', 'STALE', 'FAILED'] as const) {
      const html = render({ ...direct, status });
      expect(html, status).not.toContain('Confirm change</button>');
      expect(html, status).toContain(`data-status="${status}"`);
    }
    expect(render({ ...direct, status: 'STALE' })).toContain('This changed since the card was made');
    expect(render({ ...direct, status: 'REJECTED' })).toContain('Nothing was changed.');
  });

  it('a card whose window has passed shows as expired even before the server says so', () => {
    expect(render({ ...direct, expiresAt: PAST })).toContain('>expired</span>');
  });

  it('a stale refusal from confirm closes the card', () => {
    const html = render(direct, decisionFailure(new ApiError({ status: 409, category: 'conflict', code: 'action_stale', message: 'The object changed' })));
    expect(html).toContain('data-status="STALE"');
    expect(html).not.toContain('Confirm change</button>');
  });

  it('reports a card decided elsewhere without buttons', () => {
    const html = render(direct, { ok: false, message: 'Action is already executed.', settled: 'DECIDED' });
    expect(html).toContain('Action is already executed.');
    expect(html).not.toContain('Confirm change</button>');
  });
});

describe('earlier proposals (before cards)', () => {
  it('render as a direct card, and an older confirm answer still shows its links', () => {
    expect(toActionCard(legacy)).toMatchObject({ title: legacy.description, kind: 'direct', status: 'PENDING', warnings: [] });
    const html = render(legacy, { ok: true, status: 'EXECUTED', links: [{ label: 'Maya', detail: 'status PAUSED', href: '/agents/x' }], table: null });
    expect(html).toContain('Applied.');
    expect(html).toContain('href="/agents/x"');
  });
});

describe('card helpers', () => {
  it('orders checkers suggested first, then by name', () => {
    expect(orderedCheckers(governed).map((c) => c.name)).toEqual(['Tomas Shetty', 'Asha Rao']);
  });

  it('statusOf prefers the server card, then settled refusals, then the clock', () => {
    const now = Date.now();
    expect(statusOf(direct, { ok: true, card: { ...direct, status: 'SUBMITTED' } }, now)).toBe('SUBMITTED');
    expect(statusOf(direct, { ok: false, message: 'x', settled: 'EXPIRED' }, now)).toBe('EXPIRED');
    expect(statusOf(direct, { ok: false, message: 'x', settled: null }, now)).toBe('PENDING');
    expect(statusOf({ ...direct, expiresAt: PAST }, undefined, now)).toBe('EXPIRED');
  });

  it('decisionFailure maps API refusals', () => {
    const err = (status: number, code: string, message: string) => new ApiError({ status, category: status === 403 ? 'authorization' : 'conflict', code, message });
    expect(decisionFailure(err(409, 'action_not_pending', 'Action is already executed'))).toEqual({ ok: false, message: 'Action is already executed.', settled: 'DECIDED' });
    expect(decisionFailure(err(403, 'forbidden', 'This proposal has expired'))).toMatchObject({ settled: 'EXPIRED' });
    expect(decisionFailure(err(409, 'action_stale', 'x'))).toMatchObject({ settled: 'STALE' });
    expect(decisionFailure(err(409, 'ask_ocso_writes_off', 'x'))).toMatchObject({ settled: null, message: expect.stringContaining('turned off') });
    expect(decisionFailure(err(403, 'forbidden', 'agents.manage'))).toEqual({ ok: false, message: 'Not allowed for your role: agents.manage', settled: null });
    expect(decisionFailure(err(400, 'reason_required', 'Give a reason of 3 to 500 characters.'))).toMatchObject({ field: 'reason', settled: null });
    expect(decisionFailure(err(400, 'checker_not_eligible', 'Choose one of the checkers on the card.'))).toMatchObject({ field: 'checkerId' });
    expect(decisionFailure(err(409, 'action_outdated', 'This proposal is from an earlier version of Ask OCSO. Ask again to get a confirmation card.'))).toMatchObject({ settled: 'DECIDED' });
    expect(decisionFailure(new Error('boom'))).toEqual({ ok: false, message: 'Something went wrong. Try again.', settled: null });
  });

  it('fromAnswer reads a card, an older links answer, or an empty 204', () => {
    expect(fromAnswer({ card: { ...direct, status: 'EXECUTED' } }, 'EXECUTED')).toMatchObject({ ok: true, card: { status: 'EXECUTED' } });
    expect(fromAnswer({ legacy: { links: [] } }, 'EXECUTED')).toEqual({ ok: true, status: 'EXECUTED', links: [], table: null });
    expect(fromAnswer({ card: null }, 'REJECTED')).toEqual({ ok: true, status: 'REJECTED' });
  });

  it('readActionAnswer never reports a body it cannot read as applied', () => {
    expect(readActionAnswer(undefined, 'reject')).toEqual({ card: null });
    expect(readActionAnswer({ ...direct, status: 'REJECTED' }, 'reject')).toMatchObject({ card: { status: 'REJECTED' } });
    const link = { label: 'Maya', href: `/agents/${AGENT}` };
    expect(readActionAnswer({ links: [link] }, 'confirm')).toMatchObject({ legacy: { links: [{ label: 'Maya' }] } });
    // A card that misses the schema by one field (a future status, a null title): not "Applied".
    const unknownStatus = readActionAnswer({ ...direct, status: 'QUEUED' }, 'confirm');
    const nullTitle = readActionAnswer({ ...direct, title: null, status: 'FAILED' }, 'confirm');
    const rejectOdd = readActionAnswer({ ...direct, status: 'CANCELLED_BY_ROBOT' }, 'reject');
    const bare = readActionAnswer({}, 'confirm');
    const legacyOnReject = readActionAnswer({ links: [link] }, 'reject');
    for (const a of [unknownStatus, nullTitle, rejectOdd, bare, legacyOnReject]) {
      expect(a).toEqual({ unreadable: true });
      for (const fallback of ['EXECUTED', 'REJECTED'] as const) {
        const d = fromAnswer(a, fallback);
        expect(d.ok).toBe(false);
        expect(d).toMatchObject({ settled: 'DECIDED' });
      }
    }
    const html = render(direct, fromAnswer(unknownStatus, 'EXECUTED'));
    expect(html).not.toContain('Applied');
  });
});
