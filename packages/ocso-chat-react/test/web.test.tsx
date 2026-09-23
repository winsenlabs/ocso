// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChoiceButtons, MessageList, OcsoChat, OcsoChatProvider, TypingIndicator, useOcsoChat, useOcsoChatState } from '../src/index.js';
import { fakeClient, msg, text, webConfig } from './helpers/fake-client.js';

afterEach(cleanup);

describe('<OcsoChat />', () => {
  it('renders an accessible log and a labelled composer; Enter sends, Shift+Enter does not', async () => {
    const fake = fakeClient({ config: webConfig, messages: [msg({ id: 'm:1', role: 'assistant', author: { name: 'Maya' }, parts: [text('Hello! See https://x.test/help.')] })] });
    render(<OcsoChat client={fake.client} />);
    expect(fake.calls.connect).toBe(1);
    const log = screen.getByRole('log', { name: 'Chat messages' });
    expect(log.textContent).toContain('Hello!');
    expect(screen.getByRole('link', { name: 'https://x.test/help' }).getAttribute('rel')).toContain('noopener');
    expect(screen.getByRole('heading', { name: 'Meridian help' })).toBeTruthy();
    expect((screen.getByRole('region', { name: 'Meridian help' }) as HTMLElement).style.getPropertyValue('--ocso-accent')).toBe('#123456');
    const input = screen.getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'line one' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(fake.calls.send).toEqual([]);
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(fake.calls.send).toEqual([{ text: 'line one', attachments: [] }]);
    expect(input.value).toBe('');
  });

  it('shows the greeting when empty and a banner with retry when the chat is unavailable', () => {
    const fake = fakeClient({ config: webConfig, status: 'error' });
    render(<OcsoChat client={fake.client} />);
    expect(screen.getByText('Hi! Ask us anything.')).toBeTruthy();
    expect(screen.getByText('Chat is unavailable right now.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(fake.calls.reconnect).toBe(1);
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('offers retry and delete on a failed message', () => {
    const fake = fakeClient({ messages: [msg({ id: 'c:cm_1', role: 'customer', status: 'failed', error: 'network', parts: [text('hi')] })] });
    render(<OcsoChat client={fake.client} />);
    expect(screen.getByRole('alert').textContent).toContain('Not sent.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(fake.calls.retry).toEqual(['c:cm_1']);
    expect(fake.calls.discard).toEqual(['c:cm_1']);
  });

  it('stages attachments within the channel limits and sends them', async () => {
    const fake = fakeClient({ config: webConfig });
    const { container } = render(<OcsoChat client={fake.client} />);
    const picker = container.querySelector('input[type=file]') as HTMLInputElement;
    expect(picker.getAttribute('accept')).toBe('image/png');
    const good = new File([new Uint8Array(10)], 'receipt.png', { type: 'image/png' });
    const big = new File([new Uint8Array(5000)], 'huge.png', { type: 'image/png' });
    fireEvent.change(picker, { target: { files: [good, big] } });
    expect(screen.getByRole('alert').textContent).toBe('That file is too large.');
    expect(screen.getByRole('button', { name: 'Remove receipt.png' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    });
    expect(fake.calls.send).toHaveLength(1);
    expect((fake.calls.send[0] as { attachments: File[] }).attachments.map((f) => f.name)).toEqual(['receipt.png']);
  });

  it('asks for CSAT once the conversation is resolved', async () => {
    const fake = fakeClient({ mode: 'resolved' });
    render(<OcsoChat client={fake.client} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '5 out of 5' }));
    });
    expect(fake.calls.csat).toEqual([5]);
    expect(screen.getByText('Thanks for your feedback!')).toBeTruthy();
  });

  it('creates, connects and disconnects its own client from options', async () => {
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'nope' } }), { status: 404 });
    };
    const view = render(<OcsoChat options={{ baseUrl: 'https://ocso.test', publishableKey: 'pk_test_1234', fetch }} />);
    await screen.findByText('Chat is unavailable right now.');
    expect(calls.some((u) => u.endsWith('/public/webchat/pk_test_1234/session'))).toBe(true);
    view.unmount();
  });
});

describe('composable parts', () => {
  it('ChoiceButtons: sends the tapped option once; older questions are disabled in the log', async () => {
    const choices = { type: 'choices' as const, prompt: 'Which product?', options: [{ id: 'cards', label: 'Cards' }, { id: 'loans', label: 'Loans' }] };
    const fake = fakeClient({
      messages: [msg({ id: 'm:1', role: 'assistant', parts: [{ ...choices, prompt: 'Old question' }] }), msg({ id: 'm:2', role: 'assistant', parts: [choices] })],
    });
    render(
      <OcsoChatProvider client={fake.client} autoConnect={false}>
        <MessageList />
      </OcsoChatProvider>,
    );
    const [oldGroup, newGroup] = screen.getAllByRole('group');
    expect((oldGroup?.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    const loans = Array.from(newGroup?.querySelectorAll('button') ?? []).find((b) => b.textContent === 'Loans') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(loans);
    });
    expect(fake.calls.sendChoice).toEqual([{ id: 'loans', label: 'Loans' }]);
    expect(loans.getAttribute('aria-pressed')).toBe('true');
    expect(loans.disabled).toBe(true);
    expect(fake.calls.connect).toBe(0);
  });

  it('ChoiceButtons standalone reads the latest question', () => {
    const fake = fakeClient({ messages: [msg({ id: 'm:1', role: 'assistant', parts: [{ type: 'choices', prompt: 'Pick one', options: [{ id: 'a', label: 'A' }] }] })] });
    render(
      <OcsoChatProvider client={fake.client}>
        <ChoiceButtons />
      </OcsoChatProvider>,
    );
    expect(screen.getByRole('group', { name: 'Pick one' })).toBeTruthy();
    act(() => fake.set({ messages: [...fake.client.getState().messages, msg({ id: 'c:x', role: 'customer', parts: [text('A')] })] }));
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('TypingIndicator announces who is typing', () => {
    const fake = fakeClient();
    render(
      <OcsoChatProvider client={fake.client}>
        <TypingIndicator />
      </OcsoChatProvider>,
    );
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    act(() => fake.set({ typing: { who: 'ai', name: 'Maya' } }));
    expect(status.textContent).toBe('Maya is typing…');
  });

  it('MessageList honours classNames, renderMessage and renderPart', () => {
    const fake = fakeClient({ messages: [msg({ id: 'm:1', role: 'assistant', parts: [text('hi'), { type: 'media', kind: 'image', url: 'https://cdn.test/a.png', name: 'a.png' }] }), msg({ id: 'n:1', role: 'system', parts: [text('Priya joined the chat')], notice: { kind: 'joined', name: 'Priya' } })] });
    render(
      <OcsoChatProvider client={fake.client}>
        <MessageList
          classNames={{ log: 'my-log', bubble: 'my-bubble' }}
          renderPart={(part, _m, fallback) => (part.type === 'media' ? <em>custom media</em> : fallback())}
          renderMessage={(m, fallback) => (m.role === 'system' ? <strong>{`notice: ${m.notice?.name}`}</strong> : fallback())}
        />
      </OcsoChatProvider>,
    );
    expect(screen.getByRole('log').className).toContain('my-log');
    expect(document.querySelector('.my-bubble')).toBeTruthy();
    expect(screen.getByText('custom media')).toBeTruthy();
    expect(screen.getByText('notice: Priya')).toBeTruthy();
  });
});

describe('hooks', () => {
  it('useOcsoChatState re-renders only when the selected slice changes', () => {
    const fake = fakeClient();
    let renders = 0;
    function Mode() {
      renders++;
      return <span>{useOcsoChatState((s) => s.mode)}</span>;
    }
    render(
      <OcsoChatProvider client={fake.client}>
        <Mode />
      </OcsoChatProvider>,
    );
    const before = renders;
    act(() => fake.set({ typing: { who: 'ai' } }));
    expect(renders).toBe(before);
    act(() => fake.set({ mode: 'human' }));
    expect(renders).toBe(before + 1);
    expect(screen.getByText('human')).toBeTruthy();
  });

  it('useOcsoChat exposes input/handleSubmit and throws outside a provider', async () => {
    const fake = fakeClient();
    let api: ReturnType<typeof useOcsoChat> | null = null;
    function Probe() {
      api = useOcsoChat();
      return null;
    }
    render(
      <OcsoChatProvider client={fake.client}>
        <Probe />
      </OcsoChatProvider>,
    );
    act(() => api!.setInput('  hello  '));
    await act(async () => {
      await api!.handleSubmit({ preventDefault: () => undefined });
    });
    expect(fake.calls.send).toEqual([{ text: 'hello', attachments: [] }]);
    function Orphan() {
      useOcsoChat();
      return null;
    }
    const spy = console.error;
    console.error = () => undefined;
    try {
      expect(() => render(<Orphan />)).toThrow(/OcsoChatProvider/);
    } finally {
      console.error = spy;
    }
  });
});
