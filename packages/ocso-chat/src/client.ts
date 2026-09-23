import { ChatApi, ChatApiError } from './api.js';
import { Emitter } from './emitter.js';
import { LiveManager } from './live-manager.js';
import { defaultStorage, platformFetch, randomId, revokeObjectUrl, timers } from './platform.js';
import { coreReducer, initialCoreState, type CoreAction, type CoreState, type PendingSend } from './reducer.js';
import { deliver, isUploaded, placeholder, uploadFile, type SenderDeps } from './sender.js';
import { VisitorSession } from './session.js';
import type { AbortSignalLike, AttachmentInput, ChatError, ChatEventName, ChatEvents, ChatState, ChoiceOption, CsatResult, OcsoChatClient, OcsoChatOptions, SendInput, UploadResult, WebChatConfig } from './types.js';
import { applyLiveEvent } from './events.js';
import { chatStatus, CHOICE_REPLY_SCHEMA, publicMode, toChatError, toMessages, toNotices, type Phase } from './view.js';
import type { LiveEvent } from './wire.js';

const HISTORY_PAGE = 200;
const MAX_PAGES = 5;


/**
 * Create a headless OCSO web chat client. Framework-free: subscribe to state
 * changes, or use @winsendotai/ocso-chat-react for hooks and components.
 */
export function createOcsoChat(options: OcsoChatOptions): OcsoChatClient {
  return new Client(options);
}

class Client implements OcsoChatClient {
  private readonly api: ChatApi;
  private readonly session: VisitorSession;
  private readonly baseUrl: string;
  private readonly emitter = new Emitter<ChatEvents>();
  private readonly listeners = new Set<(state: ChatState) => void>();
  private core: CoreState = initialCoreState;
  private phase: Phase = 'idle';
  private readonly live: LiveManager;
  private error: ChatError | null = null;
  private config: WebChatConfig | null = null;
  private connecting: Promise<void> | null = null;
  private tick: unknown = null;
  /** Bumped on identity switches so late responses for the old visitor are dropped. */
  private epoch = 0;
  /** Bumped by disconnect() so a start() still waiting on the session does not open the stream afterwards. */
  private generation = 0;
  private readonly files = new Map<string, Array<AttachmentInput | null>>();
  private snapshot: ChatState;
  private readonly sender: SenderDeps;

  constructor(options: OcsoChatOptions) {
    if (!options.baseUrl) throw new Error('createOcsoChat: baseUrl is required');
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(options.publishableKey ?? '')) throw new Error('createOcsoChat: publishableKey is invalid');
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.api = new ChatApi(this.baseUrl, options.publishableKey, options.fetch ?? platformFetch());
    this.session = new VisitorSession(this.api, options.storage ?? defaultStorage(), {
      getSessionPass: options.getSessionPass,
      getUserToken: options.getUserToken,
      context: options.context,
    });
    this.sender = {
      api: this.api,
      token: async () => this.session.token ?? (await this.session.start()).token,
      refresh: () => this.session.refresh(),
      dispatch: (action) => this.dispatch(action),
      getState: () => this.core,
    };
    this.live = new LiveManager({
      api: this.api,
      preference: options.transport ?? 'auto',
      pollIntervalMs: options.pollIntervalMs ?? 2_000,
      token: () => this.session.token,
      onUnauthorized: async () => void (await this.session.refresh()),
      onFatal: (error) => {
        timers.stop(this.tick);
        this.tick = null;
        this.phase = 'failed';
        this.setError(toChatError(error));
      },
      onEvent: (event) => this.onEvent(event),
      poll: () => this.gapFill(),
      onChange: () => this.publish(),
    });
    this.snapshot = this.build();
  }

  // ───────────── state ─────────────

  getState = (): ChatState => this.snapshot;

  subscribe = (listener: (state: ChatState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  on<E extends ChatEventName>(event: E, fn: (payload: ChatEvents[E]) => void): () => void {
    return this.emitter.on(event, fn);
  }

  private build(): ChatState {
    const typing = this.core.typing && this.core.mode !== 'human' ? { who: 'ai' as const, ...(this.core.agentName ? { name: this.core.agentName } : {}) } : null;
    return {
      status: chatStatus(this.phase, this.live.status),
      mode: publicMode(this.core.mode),
      messages: toMessages(this.core, this.baseUrl),
      typing,
      notices: toNotices(this.core),
      error: this.error,
      config: this.config,
      conversationId: this.core.conversationId,
      agentName: this.core.agentName ?? this.config?.assistantName ?? null,
      humanName: this.core.humanName,
      authenticated: this.session.authenticated,
      transport: this.live.kind,
    };
  }

  private publish(): void {
    const prev = this.snapshot;
    const next = this.build();
    this.snapshot = next;
    if (prev.status !== next.status) this.emitter.emit('status', next.status);
    if (prev.mode !== next.mode) this.emitter.emit('mode', next.mode);
    if (next.error && prev.error !== next.error) this.emitter.emit('error', next.error);
    this.emitter.emit('state', next);
    for (const listener of [...this.listeners]) listener(next);
  }

  private dispatch(action: CoreAction): void {
    const next = coreReducer(this.core, action);
    if (next === this.core) return;
    this.core = next;
    this.publish();
  }

  private setError(error: ChatError | null): void {
    this.error = error;
    this.publish();
  }

  // ───────────── lifecycle ─────────────

  connect(): Promise<void> {
    if (this.phase === 'started') return Promise.resolve();
    if (!this.connecting) {
      const connecting: Promise<void> = this.start().finally(() => {
        if (this.connecting === connecting) this.connecting = null;
      });
      this.connecting = connecting;
    }
    return this.connecting;
  }

  private async start(): Promise<void> {
    const generation = this.generation;
    this.phase = 'starting';
    this.error = null;
    this.publish();
    if (!this.config) void this.api.config().then((config) => ((this.config = config), this.publish())).catch(() => undefined);
    try {
      await this.session.start();
      // disconnect() ran while the session call was in flight (e.g. the provider unmounted): stay down.
      if (generation !== this.generation) return;
      this.live.start();
      this.tick ??= timers.every(() => this.dispatch({ type: 'tick', now: Date.now() }), 5_000);
      this.phase = 'started';
      this.publish();
      await this.gapFill().catch(() => undefined);
    } catch (err) {
      if (generation !== this.generation) return;
      this.phase = 'failed';
      this.setError(toChatError(err));
      throw err;
    }
  }

  disconnect(): void {
    this.generation += 1;
    this.connecting = null;
    this.live.stop();
    timers.stop(this.tick);
    this.tick = null;
    this.phase = 'idle';
    this.publish();
  }

  reconnect(): void {
    if (this.phase === 'failed' || this.phase === 'idle') void this.connect().catch(() => undefined);
    else this.live.reconnectNow();
  }

  /** Fetch what the state lacks: the latest page first, then pages after the last seen seq. */
  private async gapFill(): Promise<void> {
    const epoch = this.epoch;
    const token = this.session.token;
    if (!token) return;
    for (let page = 0; page < MAX_PAGES; page++) {
      const after = this.core.lastSeq;
      const history = await this.api.history(token, after);
      if (epoch !== this.epoch) return;
      this.dispatch({ type: 'history', history, mode: after === 0 ? 'replace' : 'merge' });
      if (after === 0 || history.messages.length < HISTORY_PAGE) break;
    }
  }

  private onEvent(event: LiveEvent): void {
    applyLiveEvent(
      {
        core: () => this.core,
        snapshot: () => this.snapshot,
        dispatch: (action) => this.dispatch(action),
        emit: (name, payload) => this.emitter.emit(name, payload),
        gapFill: () => this.gapFill(),
      },
      event,
    );
  }

  // ───────────── actions ─────────────

  async send(input: SendInput): Promise<void> {
    const request = typeof input === 'string' ? { text: input } : input;
    const text = (request.text ?? '').trim();
    const files = request.attachments ?? [];
    const choice = request.choice;
    if (!text && !files.length && !choice) throw new ChatApiError(0, 'empty_message', 'Nothing to send');
    const pending: PendingSend = {
      clientMessageId: randomId('cm_'),
      text: choice ? '' : text,
      attachments: files.map(placeholder),
      status: 'sending',
      at: new Date().toISOString(),
      ...(choice ? { structured: { schema: CHOICE_REPLY_SCHEMA, data: { id: choice.id, title: choice.label, source: 'webchat' }, fallbackText: choice.label } } : {}),
    };
    const toUpload = files.map((f) => (isUploaded(f) ? null : f));
    this.files.set(pending.clientMessageId, toUpload);
    this.dispatch({ type: 'send', pending });
    if (this.phase === 'idle' || this.phase === 'failed') void this.connect().catch(() => undefined);
    await deliver(this.sender, pending.clientMessageId, toUpload);
    this.files.delete(pending.clientMessageId);
  }

  sendChoice(choice: ChoiceOption): Promise<void> {
    return this.send({ choice });
  }

  async retry(id: string): Promise<void> {
    const clientMessageId = id.replace(/^c:/, '');
    if (!this.core.pending.some((p) => p.clientMessageId === clientMessageId)) return;
    this.dispatch({ type: 'retry', clientMessageId });
    await deliver(this.sender, clientMessageId, this.files.get(clientMessageId) ?? []);
    this.files.delete(clientMessageId);
  }

  discard(id: string): void {
    const clientMessageId = id.replace(/^c:/, '');
    const pending = this.core.pending.find((p) => p.clientMessageId === clientMessageId);
    for (const a of pending?.attachments ?? []) revokeObjectUrl(a.previewUrl);
    this.files.delete(clientMessageId);
    this.dispatch({ type: 'discard', clientMessageId });
  }

  upload(file: AttachmentInput, signal?: AbortSignalLike): Promise<UploadResult> {
    return uploadFile(this.sender, file, signal);
  }

  async rateCsat(score: 1 | 2 | 3 | 4 | 5, comment?: string): Promise<CsatResult> {
    if (!Number.isInteger(score) || score < 1 || score > 5) throw new ChatApiError(0, 'invalid_score', 'Score must be 1 to 5');
    const token = this.session.token ?? (await this.session.start()).token;
    return this.api.csat(token, score, comment);
  }

  identify(userToken: string): Promise<void> {
    return this.switchIdentity(() => this.session.identify(userToken)).then(() => {
      this.emitter.emit('identified', { authenticated: this.session.authenticated });
    });
  }

  reset(): Promise<void> {
    return this.switchIdentity(() => this.session.reset());
  }

  /** The conversation shown may change entirely: clear, reconnect, reload. */
  private async switchIdentity(change: () => Promise<unknown>): Promise<void> {
    try {
      await change();
    } catch (err) {
      this.setError(toChatError(err));
      throw err;
    }
    this.epoch += 1;
    for (const p of this.core.pending) for (const a of p.attachments) revokeObjectUrl(a.previewUrl);
    this.files.clear();
    this.core = initialCoreState;
    this.error = null;
    this.publish();
    if (this.phase !== 'started') return this.connect();
    this.live.reconnectNow();
    await this.gapFill().catch(() => undefined);
  }
}

