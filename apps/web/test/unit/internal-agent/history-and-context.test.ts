import { describe, expect, it } from 'vitest';
import { classifyChatError } from '../../../components/internal-agent/chat-errors';
import { historyToMessages } from '../../../components/internal-agent/history';
import { contextObjectLabel, pageContext } from '../../../components/internal-agent/page-context';
import { splitBlocks } from '../../../components/internal-agent/answer-text';
import { relativeTime } from '../../../components/internal-agent/thread-list';

const CONV = '0199aaaa-bbbb-7ccc-8ddd-eeeeff001122';

describe('historyToMessages (stored parts → drawer parts)', () => {
  it('maps every stored part type and keeps action status', () => {
    const messages = historyToMessages([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Raise max workers to 12' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Confirm to apply.' },
          { type: 'links', links: [{ label: 'Worker pool', href: '/system/workers' }] },
          { type: 'table', table: { columns: ['Queue', 'Waiting'], rows: [['Cards', 3]] } },
          { type: 'action', action: { id: 'x', tool: 'update_worker_settings', risk: 'HIGH_WRITE', description: 'd', expiresAt: '2026-09-22T10:00:00Z', status: 'EXECUTED' } },
          { type: 'tool', name: 'update_worker_settings', args: { maxWorkers: 12 }, ok: true },
          { type: 'denied', text: 'Not available for your role: latency breakdown.' },
          { type: 'mystery', payload: 1 },
        ],
      },
    ]);
    expect(messages[0]).toEqual({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Raise max workers to 12', state: 'done' }] });
    expect(messages[1]!.parts.map((p) => p.type)).toEqual(['text', 'data-links', 'data-table', 'data-action', 'data-step', 'data-denied']);
    const action = messages[1]!.parts.find((p) => p.type === 'data-action');
    expect(action && 'data' in action ? action.data : null).toMatchObject({ id: 'x', status: 'EXECUTED' });
    const step = messages[1]!.parts.find((p) => p.type === 'data-step');
    expect(step && 'data' in step ? step.data : null).toEqual({ label: 'update worker settings' });
  });

  it('drops rows with unknown roles and user rows without text', () => {
    expect(historyToMessages([{ id: 's', role: 'system', parts: [{ type: 'text', text: 'x' }] }, { id: 'u', role: 'user', parts: [] }])).toEqual([]);
  });
});

describe('pageContext', () => {
  it('picks the conversation or agent id from the open page', () => {
    expect(pageContext(`/conversations/${CONV}`)).toEqual({ path: `/conversations/${CONV}`, conversationId: CONV });
    expect(pageContext(`/agents/${CONV}`)).toEqual({ path: `/agents/${CONV}`, agentId: CONV });
    expect(pageContext('/system/workers')).toEqual({ path: '/system/workers' });
    expect(pageContext('/conversations/not-an-id')).toEqual({ path: '/conversations/not-an-id' });
    expect(contextObjectLabel(pageContext(`/conversations/${CONV}`))).toBe('conv_001122');
  });

  it('never sends a path the API would reject', () => {
    expect(pageContext('/search<script>').path).toBe('/');
  });
});

describe('classifyChatError', () => {
  const http = (statusCode: number, body: unknown) => Object.assign(new Error(JSON.stringify(body)), { statusCode, responseBody: JSON.stringify(body) });

  it('recognises the not-configured setup state', () => {
    expect(classifyChatError(http(400, { error: { code: 'internal_agent_not_configured', message: 'x' } }))).toEqual({ kind: 'not_configured' });
  });

  it('maps session, permission and transport failures', () => {
    expect(classifyChatError(http(401, { error: { code: 'unauthenticated' } }))).toEqual({ kind: 'signed_out' });
    expect(classifyChatError(http(403, { error: { code: 'forbidden', message: 'Missing permission internal_agent.use' } }))).toEqual({ kind: 'forbidden', message: 'Missing permission internal_agent.use' });
    expect(classifyChatError(http(503, { error: { code: 'api_unreachable' } }))).toEqual({ kind: 'offline' });
    expect(classifyChatError(new TypeError('Failed to fetch'))).toEqual({ kind: 'offline' });
  });

  it('shows the API’s safe mid-stream text, but not SDK internals', () => {
    expect(classifyChatError(new Error('Ask OCSO could not answer right now.'))).toEqual({ kind: 'failed', message: 'Ask OCSO could not answer right now.' });
    const internal = Object.assign(new Error('Type validation failed: {...}'), { name: 'AI_TypeValidationError' });
    expect(classifyChatError(internal)).toEqual({ kind: 'failed', message: 'Ask OCSO could not answer right now.' });
  });
});

describe('answer text and thread list helpers', () => {
  it('splits paragraphs and bullet lists', () => {
    expect(splitBlocks('Two things.\n\n- Maya escalates\n- Riya breaches\nThat is all.')).toEqual([
      { kind: 'p', lines: ['Two things.'] },
      { kind: 'ul', items: ['Maya escalates', 'Riya breaches'] },
      { kind: 'p', lines: ['That is all.'] },
    ]);
  });

  it('formats thread ages', () => {
    const now = Date.parse('2026-09-22T12:00:00Z');
    expect(relativeTime('2026-09-22T11:59:30Z', now)).toBe('just now');
    expect(relativeTime('2026-09-22T11:48:00Z', now)).toBe('12m ago');
    expect(relativeTime('2026-09-22T09:00:00Z', now)).toBe('3h ago');
    expect(relativeTime('2026-09-01T09:00:00Z', now)).toBe('2026-09-01');
  });
});
