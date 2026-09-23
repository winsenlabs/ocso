import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Permission } from '@ocso/auth';

/** The askOcsoWrites kill switch (PM/research/12): the settings GET default, the form, and the diffing action. */

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('redirect'); }) }));
const session = { permissions: new Set<Permission>([Permission.DEPLOYMENT_SETTINGS_MANAGE]) };
vi.mock('../../../lib/session', () => ({ getSession: vi.fn(async () => session) }));
const updateGovernance = vi.fn();
const get = vi.fn();
vi.mock('../../../lib/api/client', () => ({ api: { get: (...a: unknown[]) => get(...a), patch: vi.fn() } }));
vi.mock('../../../lib/api/governance', async (importOriginal) => ({ ...(await importOriginal<object>()), updateGovernance: (...a: unknown[]) => updateGovernance(...a) }));
vi.mock('../../../lib/actions/approvals', () => ({ checkerChoiceAction: vi.fn(() => new Promise(() => {})) }));

const { updateAssistantAction } = await import('../../../lib/actions/governance');
const { getAssistantSettings } = await import('../../../lib/api/governance');
const { AssistantForm } = await import('../../../components/settings/assistant-form');

const CHECKER = '0199aaaa-0000-7000-8000-0000000000c1';
const PROFILE = '0199aaaa-0000-7000-8000-0000000000a1';

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
const approval = { approvalChecker: CHECKER, approvalReason: 'Pause writes during the audit' };
const IDLE = { status: 'idle' } as const;

describe('Ask OCSO settings · askOcsoWrites', () => {
  beforeEach(() => {
    updateGovernance.mockReset().mockResolvedValue({});
    get.mockReset();
  });

  it('the settings GET defaults writes to on when the API does not send the field', async () => {
    get.mockImplementation(async (_path: string, schema: { parse: (v: unknown) => unknown }) => schema.parse({ internalAgentProfileId: null }));
    await expect(getAssistantSettings()).resolves.toEqual({ internalAgentProfileId: null, askOcsoWrites: true });
    get.mockImplementation(async (_path: string, schema: { parse: (v: unknown) => unknown }) => schema.parse({ internalAgentProfileId: PROFILE, askOcsoWrites: false }));
    await expect(getAssistantSettings()).resolves.toEqual({ internalAgentProfileId: PROFILE, askOcsoWrites: false });
  });

  it('turning writes off sends askOcsoWrites:false with the approval', async () => {
    const res = await updateAssistantAction(IDLE, form({ internalAgentProfileId: PROFILE, askOcsoWritesBefore: 'true', ...approval }));
    expect(updateGovernance).toHaveBeenCalledWith({ internalAgentProfileId: PROFILE, askOcsoWrites: false, approval: { checkerId: CHECKER, reason: 'Pause writes during the audit' } });
    expect(res).toEqual({ status: 'success', message: 'Ask OCSO settings saved' });
  });

  it('turning writes back on sends askOcsoWrites:true', async () => {
    await updateAssistantAction(IDLE, form({ internalAgentProfileId: PROFILE, askOcsoWritesBefore: 'false', askOcsoWrites: 'on', ...approval }));
    expect(updateGovernance.mock.calls[0]![0]).toMatchObject({ askOcsoWrites: true });
  });

  it('an unchanged switch is not sent, so a profile change does not also propose the kill switch', async () => {
    await updateAssistantAction(IDLE, form({ internalAgentProfileId: PROFILE, askOcsoWritesBefore: 'true', askOcsoWrites: 'on', ...approval }));
    await updateAssistantAction(IDLE, form({ internalAgentProfileId: '', askOcsoWritesBefore: 'false', ...approval }));
    expect(updateGovernance.mock.calls[0]![0]).not.toHaveProperty('askOcsoWrites');
    expect(updateGovernance.mock.calls[1]![0]).toEqual({ internalAgentProfileId: null, approval: { checkerId: CHECKER, reason: 'Pause writes during the audit' } });
  });

  it('needs a checker and a reason, and a Tech admin', async () => {
    const missing = await updateAssistantAction(IDLE, form({ internalAgentProfileId: PROFILE, askOcsoWritesBefore: 'true' }));
    expect(missing).toMatchObject({ status: 'error', fieldErrors: { approvalChecker: expect.any(String), approvalReason: expect.any(String) } });
    session.permissions = new Set();
    try {
      expect(await updateAssistantAction(IDLE, form({ askOcsoWritesBefore: 'true', ...approval }))).toEqual({ status: 'error', message: 'Only a Tech admin can change these settings.' });
    } finally {
      session.permissions = new Set([Permission.DEPLOYMENT_SETTINGS_MANAGE]);
    }
    expect(updateGovernance).not.toHaveBeenCalled();
  });

  it('the form carries the switch and the value it started from', () => {
    const on = renderToStaticMarkup(createElement(AssistantForm, { profiles: [{ id: PROFILE, name: 'Fast' }], profileId: PROFILE, writesEnabled: true }));
    expect(on).toContain('<input type="hidden" name="askOcsoWritesBefore" value="true"/>');
    expect(on).toMatch(/<input type="checkbox"[^>]*name="askOcsoWrites" checked=""\/>Let Ask OCSO propose changes/);
    const off = renderToStaticMarkup(createElement(AssistantForm, { profiles: [], profileId: null, writesEnabled: false }));
    expect(off).toContain('name="askOcsoWritesBefore" value="false"');
    expect(off).toMatch(/<input type="checkbox"[^>]*name="askOcsoWrites"\/>Let Ask OCSO propose changes/);
  });
});
