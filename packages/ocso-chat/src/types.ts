/**
 * Public types of @winsendotai/ocso-chat. Deliberately free of DOM and Node
 * types so the package type-checks in browsers, React Native and servers.
 */

export type MediaKind = 'IMAGE' | 'AUDIO' | 'VIDEO' | 'DOCUMENT';

/** Minimal `Response` shape the client reads (the platform `Response` satisfies it). */
export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText?: string;
  readonly headers: { get(name: string): string | null };
  readonly body?: { getReader?: () => StreamReaderLike } | null;
  json(): Promise<unknown>;
  text(): Promise<string>;
  blob?: () => Promise<unknown>;
}

export interface StreamReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array | string | undefined }>;
  cancel?: (reason?: unknown) => Promise<void>;
}

/** Any `fetch`-compatible function (the platform `fetch` satisfies it). */
export type FetchLike = (input: string, init?: any) => Promise<ResponseLike>;

/** Key-value storage for the visitor session; sync or async (localStorage, AsyncStorage, SecureStore…). */
export interface ChatStorage {
  get(key: string): string | null | undefined | Promise<string | null | undefined>;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
}

export type ContextValue = string | number | boolean;
export type ChatContext = Record<string, ContextValue>;

export type AuthMode = 'anonymous' | 'client' | 'user';
export type TransportPreference = 'auto' | 'sse' | 'poll';

export interface OcsoChatOptions {
  /** OCSO API origin, e.g. `https://chat.example.com` (the public web chat routes live under `/public/webchat`). */
  baseUrl: string;
  /** The channel's publishable key (safe to ship in apps and pages). */
  publishableKey: string;
  /** How the channel is configured to authenticate sessions. Informational: the server enforces it. */
  mode?: AuthMode;
  /** Returns a fresh session pass minted by YOUR server (`POST /session-pass` with the secret key). */
  getSessionPass?: () => Promise<string>;
  /** Returns the signed-in user's token (JWT) or null when nobody is signed in. */
  getUserToken?: () => Promise<string | null>;
  /** Page/app context sent with the session (unverified unless it comes from a session pass). */
  context?: ChatContext;
  /** Where the visitor session is kept. Default: localStorage when available, else memory. */
  storage?: ChatStorage;
  /** `auto` streams with SSE when the platform can read response bodies, else polls every 2 s. */
  transport?: TransportPreference;
  fetch?: FetchLike;
  /** Poll interval for the `poll` transport (ms, default 2000). */
  pollIntervalMs?: number;
}

/** A file to attach: a browser `File`/`Blob`, or a React Native `{ uri, name, type }` asset. */
export interface BlobLike {
  readonly size: number;
  readonly type: string;
  readonly name?: string;
}
export interface NativeFile {
  uri: string;
  name: string;
  type: string;
}
export type AttachmentInput = BlobLike | NativeFile;

/** Minimal `AbortSignal` shape (the platform `AbortSignal` satisfies it). */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', fn: () => void, options?: { once?: boolean }): void;
}

export interface ChoiceOption {
  id: string;
  label: string;
}

/** Files to upload with the message, or receipts from an earlier `upload()` (sent without re-uploading). */
export type SendInput = string | { text?: string; attachments?: Array<AttachmentInput | UploadResult>; choice?: ChoiceOption };

export type Part =
  | { type: 'text'; text: string }
  | { type: 'media'; kind: 'image' | 'audio' | 'video' | 'document'; url: string; name?: string; mime?: string }
  | { type: 'choices'; prompt?: string; options: ChoiceOption[] }
  | { type: 'unavailable'; reason: string };

export type NoticeKind = 'waiting' | 'joined' | 'ai_resumed' | 'resolved';

export interface ChatMessage {
  id: string;
  role: 'customer' | 'assistant' | 'agent' | 'system';
  parts: Part[];
  createdAt: string;
  /** Customer messages only. */
  status?: 'sending' | 'sent' | 'failed';
  author?: { name: string };
  /** The AI reply is still streaming in. */
  streaming?: boolean;
  /** System messages: the hand-off event they announce. */
  notice?: { kind: NoticeKind; name: string | null };
  /** Customer messages that failed: the error code. */
  error?: string;
  /** Server sequence number (absent for unsent and streaming messages). */
  seq?: number;
}

export interface ChatNotice {
  id: string;
  kind: NoticeKind;
  name: string | null;
  at: string;
}

export type ChatStatus = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'offline' | 'error';
export type ConversationMode = 'ai' | 'waiting' | 'human' | 'resolved';

export interface ChatError {
  code: string;
  message: string;
}

export interface WebChatBranding {
  title?: string;
  subtitle?: string;
  greeting?: string;
  accentColor?: string;
  theme: 'light' | 'dark' | 'auto';
  position: 'right' | 'left';
  launcherLabel?: string;
}

/** `GET /public/webchat/:key/config`. */
export interface WebChatConfig {
  name: string;
  assistantName: string | null;
  branding: WebChatBranding;
  inboundParts: string[];
  maxMediaBytes: Record<MediaKind, number>;
  allowedMimeTypes: Record<MediaKind, string[]>;
  maxTextLength: number;
  maxAttachmentsPerMessage: number;
  allowedOrigins: string[];
  hostIdentity: boolean;
  /** How visitors prove themselves on this channel ('anonymous' when the server predates auth modes). */
  authMode: AuthMode;
}

export interface ChatState {
  status: ChatStatus;
  mode: ConversationMode;
  messages: ChatMessage[];
  typing: { who: 'ai' | 'human'; name?: string } | null;
  notices: ChatNotice[];
  error: ChatError | null;
  config: WebChatConfig | null;
  conversationId: string | null;
  /** The AI assistant's name, or null. */
  agentName: string | null;
  /** First name of the colleague handling the chat, when a human took over. */
  humanName: string | null;
  /** The session carries a verified customer identity. */
  authenticated: boolean;
  /** The live transport in use once connected. */
  transport: 'sse' | 'poll' | null;
}

export interface UploadResult {
  uploadId: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string;
  filename: string;
}

export interface CsatResult {
  recorded: boolean;
  score: number;
  receivedAt: string;
}

export interface ChatEvents {
  /** A message from the AI or a colleague arrived (live, not from history). */
  message: ChatMessage;
  notice: ChatNotice;
  status: ChatStatus;
  mode: ConversationMode;
  error: ChatError;
  identified: { authenticated: boolean };
  state: ChatState;
}
export type ChatEventName = keyof ChatEvents;

export interface OcsoChatClient {
  /** Open (or resume) the visitor session and start the live stream. Idempotent. */
  connect(): Promise<void>;
  /** Stop the live stream (the session is kept for the next connect). */
  disconnect(): void;
  /** Send text, attachments (uploaded first) or a tapped choice. Resolves once OCSO accepted it. */
  send(input: SendInput): Promise<void>;
  /** Send a tapped choice (structured reply carrying the option id). */
  sendChoice(choice: ChoiceOption): Promise<void>;
  /** Upload one file; the receipt can be sent later with `send({ attachments })`. */
  upload(file: AttachmentInput, signal?: AbortSignalLike): Promise<UploadResult>;
  /** Switch to a signed-in customer (verified user token). */
  identify(userToken: string): Promise<void>;
  /** Forget this visitor (e.g. on sign-out) and start a fresh anonymous session. */
  reset(): Promise<void>;
  rateCsat(score: 1 | 2 | 3 | 4 | 5, comment?: string): Promise<CsatResult>;
  /** Retry a failed customer message. */
  retry(messageId: string): Promise<void>;
  /** Drop a failed customer message. */
  discard(messageId: string): void;
  /** Reconnect the live stream now (skips any backoff wait). */
  reconnect(): void;
  getState(): ChatState;
  subscribe(listener: (state: ChatState) => void): () => void;
  on<E extends ChatEventName>(event: E, fn: (payload: ChatEvents[E]) => void): () => void;
}
