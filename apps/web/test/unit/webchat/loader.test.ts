import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * public/ocso-webchat.js runs on customer sites; these tests execute the real
 * file against a minimal fake DOM and check its postMessage origin rules.
 */

const SOURCE = readFileSync(join(import.meta.dirname, '../../../public/ocso-webchat.js'), 'utf8');
const OCSO = 'https://chat.ocso.test';
const HOST = 'https://shop.example.test';

type Listener = (event: Record<string, unknown>) => void;

class FakeElement {
  children: FakeElement[] = [];
  attributes: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  style = { props: {} as Record<string, string>, setProperty(k: string, v: string) { this.props[k] = v; } };
  hidden = false;
  className = '';
  textContent = '';
  innerHTML = '';
  title = '';
  type = '';
  src = '';
  focused = false;
  contentWindow: { posted: Array<{ message: Record<string, unknown>; target: string }>; postMessage(m: Record<string, unknown>, t: string): void } | null = null;
  constructor(readonly tag: string) {
    if (tag === 'iframe') this.contentWindow = { posted: [], postMessage(message, target) { this.posted.push({ message: { ...message }, target }); } };
  }
  setAttribute(k: string, v: string) { this.attributes[k] = v; }
  removeAttribute(k: string) { delete this.attributes[k]; }
  getAttribute(k: string) { return this.attributes[k] ?? null; }
  appendChild(child: FakeElement) { this.children.push(child); return child; }
  attachShadow() { const root = new FakeElement('#shadow'); this.children.push(root); return root; }
  addEventListener(type: string, fn: Listener) { (this.listeners[type] ??= []).push(fn); }
  focus() { this.focused = true; }
  click() { for (const fn of this.listeners['click'] ?? []) fn({}); }
  find(predicate: (el: FakeElement) => boolean): FakeElement | undefined {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const hit = child.find(predicate);
      if (hit) return hit;
    }
    return undefined;
  }
}

function load(options: { key?: string; queue?: unknown[] } = {}) {
  const body = new FakeElement('body');
  const script = new FakeElement('script');
  script.src = `${OCSO}/ocso-webchat.js`;
  script.setAttribute('data-key', options.key ?? 'pk_live_0123456789');
  const windowListeners: Record<string, Listener[]> = {};
  const win: Record<string, unknown> = {
    location: { href: `${HOST}/checkout`, origin: HOST },
    console: { warn() {}, error() {} },
    addEventListener: (type: string, fn: Listener) => (windowListeners[type] ??= []).push(fn),
    OcsoWebChat: options.queue,
  };
  const document = {
    currentScript: script,
    body,
    createElement: (tag: string) => new FakeElement(tag),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  runInNewContext(SOURCE, { window: win, document, URL, Promise, Array, parseInt, String, Math });
  const iframe = body.find((el) => el.tag === 'iframe');
  const launcher = body.find((el) => el.tag === 'button');
  const badge = body.find((el) => el.className === 'badge');
  const panel = body.find((el) => el.className.startsWith('panel'));
  const dispatch = (origin: string, source: unknown, data: unknown) => {
    for (const fn of windowListeners['message'] ?? []) fn({ origin, source, data });
  };
  const fromWidget = (data: Record<string, unknown>) => dispatch(OCSO, iframe?.contentWindow, { source: 'ocso-webchat', v: 1, ...data });
  const api = win['OcsoWebChat'] as { open(): void; identify(t: string): Promise<{ ok: boolean }>; isOpen(): boolean; on(e: string, f: (d: unknown) => void): void };
  return { body, iframe: iframe!, launcher: launcher!, badge: badge!, panel: panel!, dispatch, fromWidget, api, container: body.children[0] };
}

const READY = { type: 'ready', branding: { accentColor: '#0f766e', position: 'left', launcherLabel: 'Chat with us', title: 'Meridian help' } };

describe('ocso-webchat.js embed loader', () => {
  it('frames /chat/<key> from its own origin and stays hidden until the widget reports ready', () => {
    const { iframe, launcher } = load();
    expect(iframe.src).toBe(`${OCSO}/chat/pk_live_0123456789?embed=1&host=${encodeURIComponent(HOST)}`);
    expect(iframe.getAttribute('sandbox')).toContain('allow-scripts');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-top-navigation');
    expect(launcher.hidden).toBe(true);
  });

  it('ignores messages from other origins or other windows, even with a valid shape', () => {
    const { iframe, launcher, dispatch } = load();
    const ready = { source: 'ocso-webchat', v: 1, ...READY };
    dispatch('https://evil.test', iframe.contentWindow, ready);
    dispatch(OCSO, { postMessage() {} }, ready);
    dispatch(HOST, iframe.contentWindow, ready);
    dispatch(OCSO, iframe.contentWindow, { ...ready, source: 'other' });
    expect(launcher.hidden).toBe(true);
  });

  it('accepts ready from the widget, applies validated branding and posts only to the OCSO origin', async () => {
    const { iframe, launcher, fromWidget, api, container } = load();
    const identified = api.identify('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjdXMtMSJ9.sig');
    expect(iframe.contentWindow!.posted).toEqual([]); // queued until ready
    fromWidget(READY);
    expect(launcher.hidden).toBe(false);
    expect(container?.style.props['--ocso-accent']).toBe('#0f766e');
    const [first] = iframe.contentWindow!.posted;
    expect(first).toMatchObject({ target: OCSO, message: { source: 'ocso-webchat-host', v: 1, type: 'identify', requestId: 'r1' } });
    fromWidget({ type: 'identified', ok: true, requestId: 'r1' });
    await expect(identified).resolves.toEqual({ ok: true, error: undefined });
  });

  it('rejects unsafe branding values', () => {
    const { fromWidget, container, body } = load();
    fromWidget({ type: 'ready', branding: { accentColor: 'red;background:url(https://evil.test)', launcherLabel: '<img src=x onerror=alert(1)>' } });
    expect(container?.style.props['--ocso-accent']).toBeUndefined();
    const label = body.find((el) => el.className === 'label');
    expect(label?.textContent).toBe('<img src=x onerror=alert(1)>'); // text, never HTML
  });

  it('opens the panel, tracks unread and closes on request from the widget', () => {
    const { iframe, launcher, badge, panel, fromWidget, api } = load();
    fromWidget(READY);
    fromWidget({ type: 'unread', count: 3 });
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('3');
    expect(launcher.getAttribute('aria-label')).toBe('Open chat, 3 new messages');
    launcher.click();
    expect(api.isOpen()).toBe(true);
    expect(panel.className).toBe('panel');
    expect(panel.getAttribute('inert')).toBeNull();
    expect(badge.hidden).toBe(true);
    expect(iframe.contentWindow!.posted.at(-1)).toEqual({ target: OCSO, message: { type: 'open', source: 'ocso-webchat-host', v: 1 } });
    fromWidget({ type: 'close' });
    expect(api.isOpen()).toBe(false);
    // Closed panels stay rendered (hidden cross-origin frames stop rendering) but are invisible and inert.
    expect(panel.className).toBe('panel closed');
    expect(panel.getAttribute('inert')).toBe('');
    expect(launcher.focused).toBe(true);
  });

  it('replays queued calls and refuses to mount without a valid key', () => {
    const queued = load({ queue: [['open']] });
    queued.fromWidget(READY);
    expect(queued.api.isOpen()).toBe(true);
    const invalid = load({ key: 'bad key!' });
    expect(invalid.body.children).toHaveLength(0);
  });
});
