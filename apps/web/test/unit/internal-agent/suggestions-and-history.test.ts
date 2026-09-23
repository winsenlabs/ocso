import { beforeEach, describe, expect, it, vi } from 'vitest';
import { historyToMessages, stepLabel } from '../../../components/internal-agent/history';
import { DrawerStateSchema } from '../../../components/internal-agent/types';

vi.mock('server-only', () => ({}));
const get = vi.fn();
const post = vi.fn();
vi.mock('../../../lib/api/client', () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) } }));

const { confirmInternalAgentAction, listInternalAgentSuggestions, rejectInternalAgentAction } = await import('../../../lib/api/internal-agent');

const CARD = {
  id: '0199aaaa-0000-7000-8000-000000000001',
  tool: 'agents.update_agent',
  title: 'Rename Maya',
  summary: '',
  kind: 'direct',
  changes: [],
  warnings: [],
  expiresAt: '2026-09-23T10:00:00.000Z',
  status: 'EXECUTED',
  result: { message: 'Renamed.', href: '/agents/x' },
};

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

describe('"What can you do?" suggestions', () => {
  it('accepts objects, strings or a wrapped list, and drops junk and duplicates', async () => {
    get.mockImplementation(async (_path: string, schema: { parse: (v: unknown) => unknown }) =>
      schema.parse({ suggestions: [{ label: 'Pause an agent', prompt: 'Pause Maya' }, 'Which queue waits longest?', { label: 'Pause an agent' }, { nope: 1 }, 42, ''] }),
    );
    expect(await listInternalAgentSuggestions()).toEqual([
      { label: 'Pause an agent', prompt: 'Pause Maya' },
      { label: 'Which queue waits longest?', prompt: 'Which queue waits longest?' },
    ]);
    expect(get.mock.calls[0]![0]).toBe('/v1/internal-agent/capabilities/suggestions');
  });

  it('the drawer state defaults to no suggestions', () => {
    expect(DrawerStateSchema.parse({ configured: true, threads: [], profiles: null }).suggestions).toBeNull();
  });
});

describe('confirm / reject calls', () => {
  it('sends checker and reason only when given, and reads the card back', async () => {
    post.mockResolvedValue(CARD);
    expect(await confirmInternalAgentAction(CARD.id, { checkerId: 'c1', reason: 'policy' })).toMatchObject({ card: { status: 'EXECUTED', result: { message: 'Renamed.' } } });
    expect(post.mock.calls[0]!.slice(0, 2)).toEqual([`/v1/internal-agent/actions/${CARD.id}/confirm`, { checkerId: 'c1', reason: 'policy' }]);
    await confirmInternalAgentAction(CARD.id);
    expect(post.mock.calls[1]![1]).toEqual({});
  });

  it('reads an older links answer and an empty 204', async () => {
    post.mockResolvedValueOnce({ data: {}, links: [{ label: 'Maya', href: '/agents/x' }] });
    expect(await confirmInternalAgentAction(CARD.id)).toEqual({ legacy: { links: [{ label: 'Maya', href: '/agents/x' }] } });
    post.mockResolvedValueOnce(undefined);
    expect(await rejectInternalAgentAction(CARD.id)).toEqual({ card: null });
  });
});

describe('thread history with cards', () => {
  it('maps stored card parts (either spelling) to data-action parts with their current status', () => {
    const [m] = historyToMessages([
      { id: 'a', role: 'assistant', parts: [{ type: 'action', action: CARD }, { type: 'card', card: { ...CARD, id: 'b', status: 'SUBMITTED' } }, { type: 'action', action: { id: 'bad' } }] },
    ]);
    expect(m!.parts.map((p) => (p.type === 'data-action' ? (p.data as { status?: string }).status : p.type))).toEqual(['EXECUTED', 'SUBMITTED']);
  });

  it('labels meta-tool steps by what they did', () => {
    expect(stepLabel('get_tools', { purpose: 'pause agent' })).toBe('find tools');
    expect(stepLabel('execute_tool', { name: 'agents.update_agent', args: {} })).toBe('agents · update agent');
    expect(stepLabel('execute_tool', { name: 'insight.queue_status' })).toBe('queue status');
    expect(stepLabel('list_conversations')).toBe('list conversations');
  });
});

describe('"What can you do?" answer from the catalog', () => {
  it('keeps the per-area summary with the chips, dropping junk and empty areas', async () => {
    const { getInternalAgentCapabilities } = await import('../../../lib/api/internal-agent');
    get.mockImplementation(async (_path: string, schema: { parse: (v: unknown) => unknown }) =>
      schema.parse({
        suggestions: [{ label: 'What needs my attention?', prompt: 'What needs my attention?', tool: 'insight.attention_summary' }],
        areas: [
          { area: 'agents', label: 'Virtual agents', reads: 5, writes: 4 },
          { area: 'x', label: 'Nothing', reads: 0, writes: 0 },
          { area: 'bad', reads: 'many' },
          { area: 'insight', label: 'Insights', reads: 9, writes: 0 },
        ],
        total: 18,
      }),
    );
    expect(await getInternalAgentCapabilities()).toEqual({
      suggestions: [{ label: 'What needs my attention?', prompt: 'What needs my attention?' }],
      areas: [
        { area: 'agents', label: 'Virtual agents', reads: 5, writes: 4 },
        { area: 'insight', label: 'Insights', reads: 9, writes: 0 },
      ],
      writesOn: null,
    });
  });

  it('carries the writes switch the endpoint reports; the drawer state defaults it on', async () => {
    const { getInternalAgentCapabilities } = await import('../../../lib/api/internal-agent');
    get.mockImplementation(async (_path: string, schema: { parse: (v: unknown) => unknown }) =>
      schema.parse({ suggestions: [], areas: [{ area: 'agents', label: 'Virtual agents', reads: 5, writes: 0 }], total: 5, writesOn: false }),
    );
    expect((await getInternalAgentCapabilities()).writesOn).toBe(false);
    expect(DrawerStateSchema.parse({ configured: true, threads: [], profiles: null }).writesOn).toBe(true);
  });

  it('an older API (a bare list) has no areas: the model answers instead', async () => {
    const { getInternalAgentCapabilities } = await import('../../../lib/api/internal-agent');
    get.mockImplementation(async (_path: string, schema: { parse: (v: unknown) => unknown }) => schema.parse(['Which queue waits longest?']));
    expect((await getInternalAgentCapabilities()).areas).toBeNull();
    expect(DrawerStateSchema.parse({ configured: true, threads: [], profiles: null }).areas).toBeNull();
  });
});
