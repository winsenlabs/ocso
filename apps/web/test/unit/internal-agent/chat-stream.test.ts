import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessageStreamWriter } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { createAskOcsoChat, type ChatStore } from '../../../components/internal-agent/chat';
import { AssistantTurn } from '../../../components/internal-agent/turns';

// Server actions (and their server-only API client) are not part of this pipeline.
vi.mock('../../../lib/actions/internal-agent', () => ({ confirmAskOcsoAction: vi.fn(), rejectAskOcsoAction: vi.fn(), chooseAskOcsoProfile: vi.fn() }));

/**
 * The drawer's client pipeline against the exact chunk sequence the API
 * controller writes (apps/api internal-agent.controller.ts): real AI SDK
 * stream encoding → our transport → Chat state → rendered answer. Covers the
 * flows the dev-scripted model cannot trigger end to end (tool steps, tables,
 * links, confirmation cards, role refusals).
 */

const THREAD = '01999999-0000-7000-8000-000000000001';
const ACTION = '01999999-0000-7000-8000-0000000000a1';
const AGENT = '01999999-0000-7000-8000-0000000000b2';

type Script = (w: UIMessageStreamWriter) => void;

function apiReply(script: Script) {
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: 'start' });
        writer.write({ type: 'data-thread', id: 'thread', data: { threadId: THREAD } });
        script(writer);
        writer.write({ type: 'data-thread', id: 'thread', data: { threadId: THREAD } });
        writer.write({ type: 'finish' });
      },
    }),
  });
}

function setup(scripts: Script[]) {
  const bodies: unknown[] = [];
  const store: ChatStore = { threadId: null, context: { path: `/agents/${AGENT}`, agentId: AGENT }, sentAt: 0 };
  const threads: string[] = [];
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return apiReply(scripts.shift() ?? (() => {}));
  });
  const chat = createAskOcsoChat({ store, onThread: (t) => threads.push(t), onFinish: () => {}, fetch: fetchImpl as unknown as typeof fetch });
  return { chat, store, bodies, threads, fetchImpl };
}

const render = (message: Parameters<typeof AssistantTurn>[0]['message']) =>
  renderToStaticMarkup(
    createElement(AssistantTurn, { message, streaming: false, durationMs: 1600, stopped: false, decisions: new Map(), onDecided: () => {}, userName: 'Leo Lead' }),
  );

describe('Ask OCSO stream → drawer', () => {
  it('sends only the question, thread and page context, then continues the thread the API names', async () => {
    const { chat, bodies, store, threads } = setup([(w) => w.write({ type: 'data-step', data: { label: 'attention summary' }, transient: true }), () => {}]);
    await chat.sendMessage({ text: 'What needs my attention?' });
    expect(bodies[0]).toEqual({
      threadId: null,
      message: { role: 'user', parts: [{ type: 'text', text: 'What needs my attention?' }] },
      context: { path: `/agents/${AGENT}`, agentId: AGENT },
    });
    expect(store.threadId).toBe(THREAD);
    expect(threads[0]).toBe(THREAD);

    await chat.sendMessage({ text: 'And yesterday?' });
    expect(bodies[1]).toMatchObject({ threadId: THREAD, message: { parts: [{ type: 'text', text: 'And yesterday?' }] } });
  });

  it('renders steps, streamed text, a table and links to OCSO pages', async () => {
    const { chat } = setup([
      (w) => {
        w.write({ type: 'data-step', data: { label: 'agent performance' }, transient: true });
        w.write({ type: 'data-table', data: { columns: ['Agent', 'Convs', 'Contained', 'Escalation', 'CSAT'], rows: [['Maya', 41, '80.0%', '20.0%', '4.40']] } });
        w.write({ type: 'data-links', data: [{ label: 'Maya · support', detail: 'escalation 20.0%', href: `/agents/${AGENT}`, status: 'warn' }, { label: 'Evil', href: 'https://evil.test/x' }] });
        w.write({ type: 'text-start', id: 't' });
        w.write({ type: 'text-delta', id: 't', delta: 'Maya escalates **most**' });
        w.write({ type: 'text-delta', id: 't', delta: ' this week.' });
        w.write({ type: 'text-end', id: 't' });
      },
    ]);
    await chat.sendMessage({ text: 'Which agent escalates most?' });
    const answer = chat.messages[1]!;
    expect(answer.parts.map((p) => p.type)).toEqual(['data-thread', 'data-step', 'data-table', 'data-links', 'text']);

    const html = render(answer);
    expect(html).toContain('1 step · agent performance · 1.6 s');
    expect(html).toContain('Maya escalates <b>most</b> this week.');
    expect(html).toContain('<span role="columnheader" class="n">Escalation</span>');
    expect(html).toContain(`href="/agents/${AGENT}"`);
    expect(html).toContain('okdot w');
    // Off-site hrefs are shown but never linked.
    expect(html).not.toContain('evil.test');
    expect(html).toContain('Evil');
  });

  it('shows a proposed write as a confirmation card with exactly what changes', async () => {
    const { chat } = setup([
      (w) => {
        w.write({ type: 'data-step', data: { label: 'update worker settings' }, transient: true });
        w.write({
          type: 'data-action',
          data: {
            id: ACTION,
            tool: 'update_worker_settings',
            risk: 'HIGH_WRITE',
            description: 'Worker configuration · min warm workers 2 → 4',
            expiresAt: '2026-09-22T10:15:00.000Z',
            changes: [{ label: 'min warm workers', before: '2', after: '4' }],
          },
        });
        w.write({ type: 'text-start', id: 't' });
        w.write({ type: 'text-delta', id: 't', delta: 'Nothing changes until you confirm.' });
        w.write({ type: 'text-end', id: 't' });
      },
    ]);
    await chat.sendMessage({ text: 'Increase minimum warm workers from 2 to 4' });
    const html = render(chat.messages[1]!);
    expect(html).toContain('confirm sensitive change');
    expect(html).toContain('Worker configuration · min warm workers 2 → 4');
    expect(html).toContain('min warm workers');
    expect(html).toContain('2 → <b>4</b>');
    expect(html).toContain('>Confirm change</button>');
    expect(html).toContain('>Reject</button>');
    expect(html).toContain('attributed to Leo Lead');
  });

  it('explains a role refusal instead of answering around it', async () => {
    const { chat } = setup([
      (w) => {
        w.write({ type: 'data-step', data: { label: 'latency breakdown' }, transient: true });
        w.write({ type: 'data-denied', data: { message: 'Not available for your role: latency breakdown.' } });
        w.write({ type: 'text-start', id: 't' });
        w.write({ type: 'text-delta', id: 't', delta: 'That needs the Tech admin.' });
        w.write({ type: 'text-end', id: 't' });
      },
    ]);
    await chat.sendMessage({ text: 'Why did latency spike?' });
    const html = render(chat.messages[1]!);
    expect(html).toContain('<div class="denied" role="note"><b style="color:var(--ink-2)">Not available for your role: latency breakdown.</b>');
    expect(html).toContain('did not try another way');
  });

  it('surfaces a mid-stream API error as the chat error', async () => {
    const { chat } = setup([(w) => w.write({ type: 'error', errorText: 'Ask OCSO could not answer right now.' })]);
    await chat.sendMessage({ text: 'Anything?' });
    expect(chat.status).toBe('error');
    expect(chat.error?.message).toBe('Ask OCSO could not answer right now.');
  });
});
