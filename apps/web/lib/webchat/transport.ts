import type { ChatTransport, UIMessageChunk } from 'ai';
import { WebChatApiError, type WebChatApi } from './api';
import type { LiveConnection } from './live';
import type { VisitorSession } from './session';
import { backoffDelay } from './sse';
import type { ChatStore } from './store';
import type { OutgoingMessage } from './types';
import type { OcsoUIMessage } from './ui-messages';

/**
 * AI SDK `ChatTransport` over OCSO's public web chat API (ADR-007).
 *
 * OCSO turns run in workers and reach the customer over the conversation's
 * live stream — possibly from a human colleague, possibly minutes later — so
 * replies are not the body of the send request:
 * - `sendMessages` → `POST /messages` (idempotent by clientMessageId, retried
 *   with backoff) and returns an empty chunk stream once OCSO has accepted it;
 * - `reconnectToStream` → reconnects the live SSE stream (`LiveConnection`),
 *   whose events feed the canonical store; it never returns a per-request
 *   stream (`null`), so `useChat` never invents assistant messages.
 * Everything the widget shows comes from the store (see ui-messages.ts),
 * deduplicated by interaction id.
 */

export interface TransportDeps {
  api: WebChatApi;
  session: VisitorSession;
  store: ChatStore;
  live: () => LiveConnection | null;
  maxAttempts?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });

/** The POST body for an outgoing UI message (text parts + upload receipts in metadata). */
export function toOutgoing(message: OcsoUIMessage): OutgoingMessage {
  const clientMessageId = message.metadata?.clientMessageId ?? message.id.replace(/^c:/, '');
  const text = message.parts
    .flatMap((p) => (p.type === 'text' ? [p.text] : []))
    .join('\n')
    .trim();
  const attachments = (message.metadata?.attachments ?? []).map((a) => ({
    uploadId: a.uploadId,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    filename: a.filename,
    ...(a.sha256 ? { sha256: a.sha256 } : {}),
  }));
  return { clientMessageId, ...(text ? { text } : {}), attachments };
}

export class OcsoChatTransport implements ChatTransport<OcsoUIMessage> {
  constructor(private readonly deps: TransportDeps) {}

  async sendMessages(options: Parameters<ChatTransport<OcsoUIMessage>['sendMessages']>[0]): Promise<ReadableStream<UIMessageChunk>> {
    const outgoing = [...options.messages].reverse().find((m) => m.role === 'user' && m.metadata?.delivery === 'sending');
    if (!outgoing) throw new Error('No outgoing message to send');
    await this.deliver(outgoing, options.abortSignal);
    return new ReadableStream<UIMessageChunk>({ start: (controller) => controller.close() });
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    this.deps.live()?.reconnectNow();
    return null;
  }

  /** POST one outgoing message; marks it sent or failed in the store. Also used for manual retry. */
  async deliver(message: OcsoUIMessage, signal?: AbortSignal): Promise<void> {
    const body = toOutgoing(message);
    const { store, session, api } = this.deps;
    const max = this.deps.maxAttempts ?? 4;
    const sleep = this.deps.sleep ?? wait;
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      try {
        const token = session.token ?? (await session.start()).token;
        const result = await api.send(token, body);
        store.dispatch({ type: 'sent', clientMessageId: body.clientMessageId, interactionId: result.interactionId, conversationId: result.conversationId });
        return;
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        const apiError = err instanceof WebChatApiError ? err : new WebChatApiError(0, 'network', (err as Error).message);
        if (apiError.status === 401 && !refreshed) {
          refreshed = true;
          await session.refresh().catch(() => undefined);
          continue;
        }
        if (apiError.retriable && attempt < max) {
          await sleep(backoffDelay(attempt, { baseMs: 800, maxMs: 8_000, jitter: 0.3 }), signal);
          continue;
        }
        store.dispatch({ type: 'send-failed', clientMessageId: body.clientMessageId, error: apiError.code });
        throw apiError;
      }
    }
  }
}
