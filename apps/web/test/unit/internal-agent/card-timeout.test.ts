import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionCard, statusOf } from '../../../components/internal-agent/action-card';
import { afterTimeout, CARD_DECISION_TIMEOUT_MS, honestCard, readActionAnswer, readCardStatus, UNKNOWN_MESSAGE } from '../../../components/internal-agent/decisions';
import type { ActionCardData } from '../../../components/internal-agent/types';
import { ApiError, unreachableError } from '../../../lib/api/errors';

/**
 * A confirm that outlives the BFF's wait (final review: card confirm timeout; loopback abort). The BFF waits past
 * the API's own bound, and a confirm that still times out is re-read: the drawer shows the real final state, or
 * "outcome unknown" with a link to the object — never "failed" while the change may still apply.
 */

const api = vi.hoisted(() => ({
  confirmInternalAgentAction: vi.fn(),
  rejectInternalAgentAction: vi.fn(),
  getInternalAgentAction: vi.fn(),
  setInternalAgentProfile: vi.fn(),
}));
vi.mock('../../../lib/api/internal-agent', () => api);
vi.mock('next/cache', () => ({ refresh: vi.fn() }));
vi.mock('../../../lib/session', () => ({ getSession: vi.fn() }));

const { confirmAskOcsoAction, checkAskOcsoAction, rejectAskOcsoAction } = await import('../../../lib/actions/internal-agent');

const ID = '0199aaaa-0000-7000-8000-000000000001';
const AGENT = '0199aaaa-0000-7000-8000-0000000000b2';
const card: ActionCardData = {
  id: ID,
  tool: 'copilot.draft_reply',
  title: 'Draft a reply',
  summary: '',
  kind: 'direct',
  object: { kind: 'conversation', id: AGENT, name: 'Asha', href: `/conversations/${AGENT}` },
  changes: [],
  warnings: [],
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  status: 'PENDING',
};
const timeout = () => unreachableError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
});

describe('confirm waits past the API bound', () => {
  it('the BFF waits longer than the API bounds one confirm (30 s snapshot read + 90 s write)', async () => {
    const { CONFIRM_BOUND_MS } = await import('../../../../api/src/modules/internal-agent/bounds');
    expect(CARD_DECISION_TIMEOUT_MS).toBeGreaterThan(CONFIRM_BOUND_MS);
  });
});

describe('a confirm that times out is re-read, not reported as failed', () => {
  it('shows the settled card when the change finished meanwhile', async () => {
    api.confirmInternalAgentAction.mockRejectedValue(timeout());
    api.getInternalAgentAction.mockResolvedValue({ card: { ...card, status: 'EXECUTED', result: { message: 'Drafted.' } }, running: false });
    const d = await confirmAskOcsoAction(ID);
    expect(d).toEqual({ ok: true, card: expect.objectContaining({ status: 'EXECUTED' }) });
    expect(api.getInternalAgentAction).toHaveBeenCalledWith(ID);
  });

  it('shows "outcome unknown" while the confirm is still running, or when the card cannot be read', async () => {
    api.confirmInternalAgentAction.mockRejectedValue(timeout());
    api.getInternalAgentAction.mockResolvedValue({ card, running: true });
    expect(await confirmAskOcsoAction(ID)).toEqual({ ok: false, message: UNKNOWN_MESSAGE, settled: 'UNKNOWN' });
    api.getInternalAgentAction.mockRejectedValue(new ApiError({ status: 503, category: 'unreachable', code: 'api_unreachable', message: 'down' }));
    expect(await confirmAskOcsoAction(ID)).toMatchObject({ ok: false, settled: 'UNKNOWN' });
  });

  it('other errors still fail as before', async () => {
    api.confirmInternalAgentAction.mockRejectedValue(new ApiError({ status: 409, category: 'conflict', code: 'action_not_pending', message: 'Already decided' }));
    expect(await confirmAskOcsoAction(ID)).toMatchObject({ ok: false, settled: 'DECIDED' });
    expect(api.getInternalAgentAction).not.toHaveBeenCalled();
  });

  it('a cancel that times out re-reads too', async () => {
    api.rejectInternalAgentAction.mockRejectedValue(timeout());
    api.getInternalAgentAction.mockResolvedValue({ card: { ...card, status: 'REJECTED' }, running: false });
    expect(await rejectAskOcsoAction(ID)).toEqual({ ok: true, card: expect.objectContaining({ status: 'REJECTED' }) });
  });

  it('checkAskOcsoAction answers only once OCSO knows', async () => {
    api.getInternalAgentAction.mockResolvedValue({ card, running: true });
    expect(await checkAskOcsoAction(ID)).toBeNull();
    api.getInternalAgentAction.mockResolvedValue({ card: { ...card, status: 'EXECUTED' }, running: false });
    expect(await checkAskOcsoAction(ID)).toMatchObject({ ok: true, card: { status: 'EXECUTED' } });
  });
});

describe('the UNKNOWN card state', () => {
  it('reads the status endpoint and the "may or may not have applied" result as UNKNOWN, not FAILED', () => {
    const failedUnknown = { ...card, status: 'FAILED' as const, result: { message: 'OCSO did not finish this within 90 seconds, so it may or may not have applied. Check the object in OCSO before asking again.' } };
    expect(honestCard(failedUnknown).status).toBe('UNKNOWN');
    expect(honestCard({ ...card, status: 'FAILED', result: { message: 'Not allowed.' } }).status).toBe('FAILED');
    expect(readCardStatus({ ...failedUnknown, running: false })).toMatchObject({ card: { status: 'UNKNOWN' }, running: false });
    expect(readActionAnswer(failedUnknown, 'confirm')).toMatchObject({ card: { status: 'UNKNOWN' } });
    expect(readCardStatus({ ...card, running: true })).toMatchObject({ running: true });
    expect(readCardStatus({ nope: 1 })).toBeNull();
    expect(afterTimeout({ card, running: false })).toMatchObject({ settled: 'UNKNOWN' });
  });

  it('renders honestly with a link to check the object, and no Confirm button', () => {
    const decision = { ok: false as const, message: UNKNOWN_MESSAGE, settled: 'UNKNOWN' as const };
    expect(statusOf(card, decision, Date.now())).toBe('UNKNOWN');
    const html = renderToStaticMarkup(createElement(ActionCard, { action: card, decision, onDecided: () => {}, userName: 'Asha' }));
    expect(html).toContain('data-status="UNKNOWN"');
    expect(html).toContain('outcome unknown');
    expect(html).toContain(UNKNOWN_MESSAGE);
    expect(html).toContain(`href="/conversations/${AGENT}"`);
    expect(html).toContain('Check it in OCSO');
    expect(html).not.toContain('Confirm change');
    expect(html).not.toContain('failed');
  });
});
