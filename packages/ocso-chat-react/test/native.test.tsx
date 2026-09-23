import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import TestRenderer, { type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OcsoChatView } from '../src/native/index.js';
import { fakeClient, msg, text, webConfig } from './helpers/fake-client.js';
import { openedUrls } from './helpers/react-native-mock.js';

/**
 * React Native entry rendered with react-test-renderer against a minimal
 * react-native mock (test/helpers/react-native-mock.ts, aliased in the root
 * vitest config): exercises our component logic, not RN's native views.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

function mount(element: React.ReactElement): ReactTestRenderer {
  const warn = console.error;
  console.error = (...args: unknown[]) => {
    if (String(args[0]).includes('react-test-renderer is deprecated')) return;
    warn(...args);
  };
  try {
    act(() => {
      renderer = TestRenderer.create(element);
    });
  } finally {
    console.error = warn;
  }
  return renderer!;
}

const is = (n: ReactTestInstance, type: string) => (n.type as unknown) === type;

const allText = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === 'string' ? c : allText(c))).join('');

const button = (root: ReactTestInstance, label: string) =>
  root.findAll((n) => is(n, 'Pressable') && allText(n) === label)[0] as ReactTestInstance;

describe('<OcsoChatView /> (React Native)', () => {
  it('lists messages, types and sends', async () => {
    const fake = fakeClient({ config: webConfig, messages: [msg({ id: 'm:1', role: 'assistant', author: { name: 'Maya' }, parts: [text('Hi, read https://x.test/faq')] })] });
    const root = mount(<OcsoChatView client={fake.client} />).root;
    expect(fake.calls.connect).toBe(1);
    const list = root.findByType('FlatList' as never);
    expect(list.props.accessibilityLabel).toBe('Chat messages');
    expect(allText(list)).toContain('Hi, read https://x.test/faq');
    const link = root.findAll((n) => is(n, 'Text') && n.props.accessibilityRole === 'link')[0] as ReactTestInstance;
    await act(async () => link.props.onPress());
    expect(openedUrls).toContain('https://x.test/faq');
    const input = root.findByType('TextInput' as never);
    expect(input.props.accessibilityLabel).toBe('Message');
    act(() => input.props.onChangeText('where is my card?'));
    await act(async () => button(root, 'Send').props.onPress());
    expect(fake.calls.send).toEqual([{ text: 'where is my card?', attachments: [] }]);
  });

  it('sends a tapped choice and disables the question afterwards', async () => {
    const fake = fakeClient({ messages: [msg({ id: 'm:1', role: 'assistant', parts: [{ type: 'choices', prompt: 'Which product?', options: [{ id: 'cards', label: 'Cards' }] }] })] });
    const root = mount(<OcsoChatView client={fake.client} />).root;
    await act(async () => button(root, 'Cards').props.onPress());
    expect(fake.calls.sendChoice).toEqual([{ id: 'cards', label: 'Cards' }]);
    expect(button(root, 'Cards').props.disabled).toBe(true);
  });

  it('applies the theme prop over the channel accent', () => {
    const fake = fakeClient({ config: webConfig });
    const root = mount(<OcsoChatView client={fake.client} theme={{ accent: '#ff0000', radius: 4 }} />).root;
    const send = button(root, 'Send');
    const styles = [send.props.style].flat(3).filter(Boolean) as Array<Record<string, unknown>>;
    expect(styles.find((s) => 'backgroundColor' in s)?.['backgroundColor']).toBe('#ff0000');
    expect(styles.find((s) => 'borderRadius' in s)?.['borderRadius']).toBe(3);
  });

  it('stages { uri, name, type } attachments from the picker and sends them', async () => {
    const fake = fakeClient({ config: webConfig });
    const photo = { uri: 'file:///photo.jpg', name: 'photo.jpg', type: 'image/jpeg' };
    const root = mount(<OcsoChatView client={fake.client} onPickAttachment={async () => photo} />).root;
    const attach = root.findAll((n) => is(n, 'Pressable') && n.props.accessibilityLabel === 'Attach a file')[0] as ReactTestInstance;
    await act(async () => attach.props.onPress());
    expect(allText(root)).toContain('photo.jpg');
    await act(async () => button(root, 'Send').props.onPress());
    expect(fake.calls.send).toEqual([{ text: '', attachments: [photo] }]);
  });

  it('shows typing and the reconnect banner', () => {
    const fake = fakeClient({ status: 'reconnecting', typing: { who: 'ai', name: 'Maya' } });
    const root = mount(<OcsoChatView client={fake.client} />).root;
    expect(allText(root)).toContain('Maya is typing…');
    expect(allText(root)).toContain('Reconnecting…');
  });
});

describe('native entry stays DOM-free', () => {
  it('never imports react-dom or touches document/window', () => {
    const src = join(import.meta.dirname, '..', 'src');
    const files = ['core', 'native'].flatMap((dir) => readdirSync(join(src, dir)).map((f) => join(src, dir, f)));
    for (const file of files) {
      const code = readFileSync(file, 'utf8');
      expect(code, file).not.toMatch(/from ['"]react-dom|\bdocument\.|\bwindow\.|from ['"]\.\.\/web\//);
    }
  });
});
