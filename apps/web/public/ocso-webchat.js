/*!
 * OCSO web chat embed loader — dependency-free.
 *
 *   <script src="https://<ocso-host>/ocso-webchat.js" data-key="<channel public key>" async></script>
 *
 * Adds a launcher button and a panel with the chat iframe (served by OCSO at
 * /chat/<key>). Page API (calls made before the script loads can be queued:
 *   window.OcsoWebChat = window.OcsoWebChat || []; OcsoWebChat.push(['identify', jwt]);):
 *   OcsoWebChat.open() / close() / toggle()
 *   OcsoWebChat.identify(jwt) -> Promise<{ ok, error? }>   host-signed HS256 JWT (docs/08 §4)
 *   OcsoWebChat.reset()                                  forget the visitor (e.g. on logout)
 *   OcsoWebChat.on(event, fn) / off(event, fn)           'ready' | 'open' | 'close' | 'unread' | 'identified'
 * Security: messages are accepted only from the chat iframe's window AND the
 * OCSO origin this script was loaded from, and are posted only to that origin.
 */
(function () {
  'use strict';
  var w = window;
  var d = document;
  var existing = w.OcsoWebChat;
  if (existing && existing.__ocso) return;

  var HOST_SOURCE = 'ocso-webchat-host';
  var WIDGET_SOURCE = 'ocso-webchat';
  var VERSION = 1;

  var script = d.currentScript;
  if (!script) {
    var candidates = d.querySelectorAll('script[data-key][src*="ocso-webchat.js"]');
    script = candidates[candidates.length - 1];
  }
  if (!script) return;
  var key = script.getAttribute('data-key') || '';
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
    if (w.console) w.console.warn('[ocso-webchat] missing or invalid data-key');
    return;
  }
  var ocsoOrigin;
  try {
    ocsoOrigin = new URL(script.src, w.location.href).origin;
  } catch (e) {
    return;
  }

  var CSS =
    ':host{all:initial}' +
    '.launcher{position:fixed;bottom:20px;right:20px;z-index:2147483000;display:flex;align-items:center;gap:8px;height:52px;min-width:52px;padding:0 16px;border:0;border-radius:26px;background:var(--ocso-accent,#4f46e5);color:var(--ocso-on-accent,#fff);font:600 14px/1 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 6px 24px rgba(15,23,42,.24);cursor:pointer}' +
    '.launcher:focus-visible{outline:3px solid var(--ocso-accent,#4f46e5);outline-offset:3px}' +
    '.launcher svg{width:22px;height:22px;flex:none}' +
    '.launcher .label:empty{display:none}' +
    '.launcher .i-close,.open .launcher .i-chat,.open .launcher .label{display:none}.open .launcher .i-close{display:block}' +
    '.badge{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:#dc2626;color:#fff;font:700 11px/20px system-ui,sans-serif;text-align:center;box-sizing:border-box}' +
    '.badge[hidden],.launcher[hidden]{display:none}' +
    // Closed = invisible and inert, but still rendered: browsers pause rendering (and the
    // widget's startup) inside display:none / visibility:hidden cross-origin frames.
    '.panel.closed{opacity:0;pointer-events:none;transform:translateY(12px)}' +
    '.panel{transition:opacity .16s ease,transform .16s ease}' +
    '@media (prefers-reduced-motion:reduce){.panel{transition:none}}' +
    '.panel{position:fixed;bottom:84px;right:20px;z-index:2147483000;width:380px;height:620px;max-height:calc(100vh - 104px);max-width:calc(100vw - 40px);border-radius:16px;overflow:hidden;background:#fff;box-shadow:0 12px 48px rgba(15,23,42,.28)}' +
    '.panel iframe{display:block;width:100%;height:100%;border:0}' +
    '.left .launcher,.left .panel{right:auto;left:20px}' +
    '@media (max-width:480px){.panel{inset:0;width:100%;height:100%;max-width:none;max-height:none;border-radius:0}.open .launcher{display:none}}';

  var ICON =
    '<svg class="i-chat" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5A8 8 0 1 1 21 12z"/></svg>' +
    '<svg class="i-close" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  var container = d.createElement('div');
  container.setAttribute('data-ocso-webchat', '');
  var root = container.attachShadow ? container.attachShadow({ mode: 'open' }) : container;
  var style = d.createElement('style');
  style.textContent = CSS;
  var wrap = d.createElement('div');
  wrap.className = 'wrap';
  var panel = d.createElement('div');
  panel.className = 'panel closed';
  panel.setAttribute('inert', '');
  panel.setAttribute('aria-hidden', 'true');
  var iframe = d.createElement('iframe');
  iframe.title = 'Chat';
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads');
  iframe.setAttribute('referrerpolicy', 'origin');
  iframe.src = ocsoOrigin + '/chat/' + encodeURIComponent(key) + '?embed=1&host=' + encodeURIComponent(w.location.origin);
  panel.appendChild(iframe);
  var launcher = d.createElement('button');
  launcher.type = 'button';
  launcher.className = 'launcher';
  launcher.hidden = true;
  launcher.setAttribute('aria-expanded', 'false');
  launcher.setAttribute('aria-label', 'Open chat');
  launcher.innerHTML = ICON;
  var label = d.createElement('span');
  label.className = 'label';
  var badge = d.createElement('span');
  badge.className = 'badge';
  badge.hidden = true;
  badge.setAttribute('aria-hidden', 'true');
  launcher.appendChild(label);
  launcher.appendChild(badge);
  wrap.appendChild(panel);
  wrap.appendChild(launcher);
  root.appendChild(style);
  root.appendChild(wrap);

  var ready = false;
  var isOpen = false;
  var wantOpen = false;
  var unread = 0;
  var outbox = [];
  var listeners = {};
  var waiters = {};
  var seq = 0;

  function emit(type, detail) {
    var list = (listeners[type] || []).slice();
    for (var i = 0; i < list.length; i++) {
      try {
        list[i](detail);
      } catch (e) {
        if (w.console) w.console.error(e);
      }
    }
  }

  function post(message) {
    message.source = HOST_SOURCE;
    message.v = VERSION;
    if (!ready || !iframe.contentWindow) return void outbox.push(message);
    iframe.contentWindow.postMessage(message, ocsoOrigin);
  }

  function setUnread(count) {
    unread = count > 0 && count < 1000 ? Math.floor(count) : 0;
    badge.hidden = unread === 0 || isOpen;
    badge.textContent = unread > 99 ? '99+' : String(unread);
    launcher.setAttribute('aria-label', (isOpen ? 'Close chat' : 'Open chat') + (unread && !isOpen ? ', ' + unread + ' new messages' : ''));
    emit('unread', { count: unread });
  }

  function applyBranding(branding) {
    if (!branding || typeof branding !== 'object') return;
    var accent = branding.accentColor;
    if (typeof accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(accent)) {
      container.style.setProperty('--ocso-accent', accent);
      var n = parseInt(accent.slice(1), 16);
      var luminance = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
      container.style.setProperty('--ocso-on-accent', luminance > 0.6 ? '#111418' : '#ffffff');
    }
    wrap.className = branding.position === 'left' ? 'wrap left' : 'wrap';
    if (typeof branding.launcherLabel === 'string') label.textContent = branding.launcherLabel.slice(0, 40);
    if (typeof branding.title === 'string' && branding.title) iframe.title = 'Chat: ' + branding.title.slice(0, 80);
  }

  function open() {
    if (!ready) return void (wantOpen = true);
    if (isOpen) return;
    isOpen = true;
    panel.className = 'panel';
    panel.removeAttribute('inert');
    panel.removeAttribute('aria-hidden');
    wrap.className = wrap.className.replace(/ ?open/g, '') + ' open';
    launcher.setAttribute('aria-expanded', 'true');
    post({ type: 'open' });
    setUnread(0);
    try {
      iframe.focus();
    } catch (e) {
      /* focus is best effort */
    }
    emit('open');
  }

  function close() {
    wantOpen = false;
    if (!isOpen) return;
    isOpen = false;
    panel.className = 'panel closed';
    panel.setAttribute('inert', '');
    panel.setAttribute('aria-hidden', 'true');
    wrap.className = wrap.className.replace(/ ?open/g, '');
    launcher.setAttribute('aria-expanded', 'false');
    post({ type: 'close' });
    setUnread(unread);
    launcher.focus();
    emit('close');
  }

  function identify(token) {
    if (typeof token !== 'string' || token.length < 10 || token.length > 4096) return Promise.resolve({ ok: false, error: 'invalid_token' });
    var requestId = 'r' + ++seq;
    post({ type: 'identify', token: token, requestId: requestId });
    return new Promise(function (resolve) {
      waiters[requestId] = resolve;
    });
  }

  function onMessage(event) {
    if (event.origin !== ocsoOrigin || event.source !== iframe.contentWindow) return;
    var m = event.data;
    if (!m || typeof m !== 'object' || m.source !== WIDGET_SOURCE || m.v !== VERSION) return;
    if (m.type === 'ready') {
      ready = true;
      applyBranding(m.branding);
      launcher.hidden = false;
      var queued = outbox;
      outbox = [];
      for (var i = 0; i < queued.length; i++) iframe.contentWindow.postMessage(queued[i], ocsoOrigin);
      emit('ready');
      if (wantOpen) open();
    } else if (m.type === 'unread' && typeof m.count === 'number') {
      setUnread(isOpen ? 0 : m.count);
    } else if (m.type === 'close') {
      close();
    } else if (m.type === 'identified') {
      var result = { ok: m.ok === true, error: typeof m.error === 'string' ? m.error : undefined };
      var waiter = typeof m.requestId === 'string' ? waiters[m.requestId] : null;
      if (waiter) {
        delete waiters[m.requestId];
        waiter(result);
      }
      emit('identified', result);
    }
  }

  launcher.addEventListener('click', function () {
    if (isOpen) close();
    else open();
  });
  wrap.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && isOpen) close();
  });
  w.addEventListener('message', onMessage);

  var api = {
    __ocso: true,
    open: open,
    close: close,
    toggle: function () {
      if (isOpen) close();
      else open();
    },
    identify: identify,
    reset: function () {
      post({ type: 'reset' });
    },
    on: function (type, fn) {
      if (typeof fn === 'function') (listeners[type] = listeners[type] || []).push(fn);
    },
    off: function (type, fn) {
      listeners[type] = (listeners[type] || []).filter(function (f) {
        return f !== fn;
      });
    },
    isOpen: function () {
      return isOpen;
    },
  };
  w.OcsoWebChat = api;

  function mount() {
    d.body.appendChild(container);
  }
  if (d.body) mount();
  else d.addEventListener('DOMContentLoaded', mount);

  // Replay calls queued before the script loaded: OcsoWebChat.push(['identify', jwt]).
  if (existing && typeof existing.length === 'number') {
    for (var q = 0; q < existing.length; q++) {
      var call = existing[q];
      if (call && typeof call[0] === 'string' && call[0] !== '__ocso' && typeof api[call[0]] === 'function') {
        api[call[0]].apply(null, Array.prototype.slice.call(call, 1));
      }
    }
  }
})();
