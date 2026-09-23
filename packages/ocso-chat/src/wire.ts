import type { MediaKind, NoticeKind, WebChatBranding, WebChatConfig } from './types.js';

/**
 * Wire shapes of OCSO's public web chat API (`/public/webchat/:key/*`) and
 * dependency-free parsers for them. Every response is checked at the boundary;
 * unknown part types are dropped rather than failing a message.
 */

export const MEDIA_KINDS: readonly MediaKind[] = ['IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT'];

export type WireMedia = { mimeType: string; filename?: string; sizeBytes?: number; status?: string };
export type WirePart =
  | { type: 'TEXT'; text: string }
  | { type: MediaKind; media: WireMedia; url?: string; caption?: string }
  | { type: 'STRUCTURED'; schema: string; data?: Record<string, unknown>; fallbackText?: string }
  | { type: 'LOCATION'; latitude: number; longitude: number; name?: string; address?: string }
  | { type: 'CONTACT'; contacts: Array<{ name: string }> };

export interface WireMessage {
  id: string;
  seq: number;
  from: 'customer' | 'agent' | 'human';
  name: string | null;
  parts: WirePart[];
  deliveryStatus: string;
  at: string;
  turnId: string | null;
  clientMessageId: string | null;
}

export interface WireNotice {
  id: string;
  seq: number;
  kind: NoticeKind;
  name: string | null;
  at: string;
}

export type WireMode = 'ai' | 'waiting' | 'human' | 'closed';
export interface WireStatus {
  mode: WireMode;
  humanName: string | null;
}

export interface WireHistory {
  conversationId: string | null;
  agentName: string | null;
  messages: WireMessage[];
  notices: WireNotice[];
  status: WireStatus;
}

export interface WireSession {
  token: string;
  visitorId: string;
  expiresAt: string;
  authenticated: boolean;
}

export interface WireSendResult {
  status: 'accepted' | 'duplicate';
  conversationId: string;
  interactionId: string;
  seq?: number;
}

export interface WireUpload {
  uploadId: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string;
}

/** Body of POST /messages. */
export interface OutgoingMessage {
  clientMessageId: string;
  text?: string;
  attachments: Array<{ uploadId: string; mimeType: string; sizeBytes: number; filename?: string; sha256?: string }>;
  structured?: { schema: string; data: Record<string, unknown>; fallbackText?: string };
}

export type LiveEvent =
  | { event: 'ready'; data: { conversationId: string | null } }
  | { event: 'message'; data: WireMessage }
  | { event: 'delta'; data: { turnId: string; text: string } }
  | { event: 'typing'; data: { turnId: string; status: string | null } }
  | { event: 'idle'; data: { turnId: string } }
  | { event: 'notice'; data: WireNotice }
  | { event: 'status'; data: WireStatus }
  | { event: 'ping'; data: unknown };

// ───────────────────────── helpers ─────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);
const nullableStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Copy the defined optional fields only (the package is built with exactOptionalPropertyTypes). */
function defined<T extends Obj>(value: T): T {
  const out: Obj = {};
  for (const key of Object.keys(value)) if (value[key] !== undefined) out[key] = value[key];
  return out as T;
}

export class WireError extends Error {
  constructor(message = 'Unexpected response from the chat service') {
    super(message);
    this.name = 'WireError';
  }
}

// ───────────────────────── parsers ─────────────────────────

export function parsePart(v: unknown): WirePart | null {
  if (!isObj(v)) return null;
  const type = v['type'];
  if (type === 'TEXT') return typeof v['text'] === 'string' ? { type, text: v['text'] } : null;
  if (type === 'IMAGE' || type === 'AUDIO' || type === 'VIDEO' || type === 'DOCUMENT') {
    const m = v['media'];
    if (!isObj(m) || typeof m['mimeType'] !== 'string') return null;
    const media = defined<WireMedia>({ mimeType: m['mimeType'], filename: str(m['filename']), sizeBytes: num(m['sizeBytes']), status: str(m['status']) } as WireMedia);
    return defined({ type, media, url: str(v['url']), caption: str(v['caption']) }) as WirePart;
  }
  if (type === 'STRUCTURED') {
    if (typeof v['schema'] !== 'string') return null;
    return defined({ type, schema: v['schema'], data: isObj(v['data']) ? v['data'] : undefined, fallbackText: str(v['fallbackText']) }) as WirePart;
  }
  if (type === 'LOCATION') {
    const latitude = num(v['latitude']);
    const longitude = num(v['longitude']);
    if (latitude === undefined || longitude === undefined) return null;
    return defined({ type, latitude, longitude, name: str(v['name']), address: str(v['address']) }) as WirePart;
  }
  if (type === 'CONTACT') {
    const contacts = Array.isArray(v['contacts']) ? v['contacts'].flatMap((c) => (isObj(c) && typeof c['name'] === 'string' ? [{ name: c['name'] }] : [])) : [];
    return { type, contacts };
  }
  return null;
}

export function parseMessage(v: unknown): WireMessage | null {
  if (!isObj(v)) return null;
  const id = str(v['id']);
  const seq = int(v['seq']);
  const from = v['from'];
  const at = str(v['at']);
  if (!id || seq === undefined || !at || (from !== 'customer' && from !== 'agent' && from !== 'human')) return null;
  const parts = Array.isArray(v['parts']) ? v['parts'].flatMap((p) => parsePart(p) ?? []) : [];
  return {
    id,
    seq,
    from,
    name: nullableStr(v['name']),
    parts,
    deliveryStatus: str(v['deliveryStatus']) ?? 'SENT',
    at,
    turnId: nullableStr(v['turnId']),
    clientMessageId: nullableStr(v['clientMessageId']),
  };
}

const NOTICE_KINDS: readonly string[] = ['waiting', 'joined', 'ai_resumed', 'resolved'];

export function parseNotice(v: unknown): WireNotice | null {
  if (!isObj(v)) return null;
  const id = str(v['id']);
  const seq = int(v['seq']);
  const kind = str(v['kind']);
  const at = str(v['at']);
  if (!id || seq === undefined || !at || !kind || !NOTICE_KINDS.includes(kind)) return null;
  return { id, seq, kind: kind as NoticeKind, name: nullableStr(v['name']), at };
}

export function parseStatus(v: unknown): WireStatus {
  if (!isObj(v)) return { mode: 'ai', humanName: null };
  const mode = v['mode'];
  return { mode: mode === 'waiting' || mode === 'human' || mode === 'closed' ? mode : 'ai', humanName: nullableStr(v['humanName']) };
}

export function parseHistory(v: unknown): WireHistory {
  if (!isObj(v) || !Array.isArray(v['messages'])) throw new WireError();
  return {
    conversationId: nullableStr(v['conversationId']),
    agentName: nullableStr(v['agentName']),
    messages: v['messages'].flatMap((m) => parseMessage(m) ?? []),
    notices: Array.isArray(v['notices']) ? v['notices'].flatMap((n) => parseNotice(n) ?? []) : [],
    status: parseStatus(v['status']),
  };
}

export function parseSession(v: unknown): WireSession {
  if (!isObj(v) || !str(v['token'])) throw new WireError();
  return { token: v['token'] as string, visitorId: str(v['visitorId']) ?? '', expiresAt: str(v['expiresAt']) ?? '', authenticated: v['authenticated'] === true };
}

export function parseSendResult(v: unknown): WireSendResult {
  if (!isObj(v)) throw new WireError();
  const status = v['status'];
  const conversationId = str(v['conversationId']);
  const interactionId = str(v['interactionId']);
  if ((status !== 'accepted' && status !== 'duplicate') || !conversationId || !interactionId) throw new WireError();
  return defined({ status, conversationId, interactionId, seq: int(v['seq']) }) as WireSendResult;
}

export function parseUpload(v: unknown): WireUpload {
  if (!isObj(v)) throw new WireError();
  const uploadId = str(v['uploadId']);
  const mimeType = str(v['mimeType']);
  const sizeBytes = int(v['sizeBytes']);
  if (!uploadId || !mimeType || sizeBytes === undefined) throw new WireError();
  return defined({ uploadId, mimeType, sizeBytes, sha256: str(v['sha256']) }) as WireUpload;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function parseBranding(v: unknown): WebChatBranding {
  const b = isObj(v) ? v : {};
  const theme = b['theme'];
  return defined({
    title: str(b['title']),
    subtitle: str(b['subtitle']),
    greeting: str(b['greeting']),
    accentColor: typeof b['accentColor'] === 'string' && HEX_COLOR.test(b['accentColor']) ? b['accentColor'] : undefined,
    theme: theme === 'dark' || theme === 'auto' ? theme : 'light',
    position: b['position'] === 'left' ? 'left' : 'right',
    launcherLabel: str(b['launcherLabel']),
  }) as WebChatBranding;
}

function perKind<T>(v: unknown, read: (x: unknown) => T): Record<MediaKind, T> {
  const o = isObj(v) ? v : {};
  return { IMAGE: read(o['IMAGE']), AUDIO: read(o['AUDIO']), VIDEO: read(o['VIDEO']), DOCUMENT: read(o['DOCUMENT']) };
}

export function parseConfig(v: unknown): WebChatConfig {
  if (!isObj(v) || typeof v['name'] !== 'string') throw new WireError();
  return {
    name: v['name'],
    assistantName: nullableStr(v['assistantName']),
    branding: parseBranding(v['branding']),
    inboundParts: strings(v['inboundParts']),
    maxMediaBytes: perKind(v['maxMediaBytes'], (x) => Math.max(0, int(x) ?? 0)),
    allowedMimeTypes: perKind(v['allowedMimeTypes'], strings),
    maxTextLength: int(v['maxTextLength']) ?? 8000,
    maxAttachmentsPerMessage: Math.max(0, int(v['maxAttachmentsPerMessage']) ?? 0),
    allowedOrigins: strings(v['allowedOrigins']),
    hostIdentity: v['hostIdentity'] === true,
    authMode: v['authMode'] === 'client' || v['authMode'] === 'user' ? v['authMode'] : 'anonymous',
  };
}

/** One SSE message → a typed live event, or null when unknown/invalid. */
export function parseLiveEvent(event: string, data: unknown): LiveEvent | null {
  const d = isObj(data) ? data : {};
  switch (event) {
    case 'ready':
      return { event, data: { conversationId: nullableStr(d['conversationId']) } };
    case 'message': {
      const message = parseMessage(data);
      return message ? { event, data: message } : null;
    }
    case 'delta':
      return typeof d['turnId'] === 'string' && typeof d['text'] === 'string' ? { event, data: { turnId: d['turnId'], text: d['text'] } } : null;
    case 'typing':
      return typeof d['turnId'] === 'string' ? { event, data: { turnId: d['turnId'], status: nullableStr(d['status']) } } : null;
    case 'idle':
      return typeof d['turnId'] === 'string' ? { event, data: { turnId: d['turnId'] } } : null;
    case 'notice': {
      const notice = parseNotice(data);
      return notice ? { event, data: notice } : null;
    }
    case 'status':
      return { event, data: parseStatus(data) };
    case 'ping':
      return { event, data };
    default:
      return null;
  }
}
