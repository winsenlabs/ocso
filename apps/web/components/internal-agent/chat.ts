import { Chat } from '@ai-sdk/react';
import { DefaultChatTransport, type ChatOnFinishCallback, type UIMessageChunk } from 'ai';
import type { PageContext } from './page-context';
import { dataPartSchemas, type AskOcsoMessage } from './types';

/**
 * The AI SDK chat behind the Ask OCSO drawer. The API keeps the history, so
 * each request carries only the new question, the thread to continue and
 * the page context — never the whole transcript.
 */

export interface ChatStore {
  threadId: string | null;
  context: PageContext | null;
  sentAt: number;
}

/** Step lines stream as transient progress; keep them as parts so the answer shows what OCSO checked. */
export class AskOcsoTransport extends DefaultChatTransport<AskOcsoMessage> {
  protected override processResponseStream(stream: ReadableStream<Uint8Array<ArrayBufferLike>>): ReadableStream<UIMessageChunk> {
    return super.processResponseStream(stream).pipeThrough(
      new TransformStream<UIMessageChunk, UIMessageChunk>({
        transform(chunk, controller) {
          controller.enqueue(chunk.type === 'data-step' && 'transient' in chunk && chunk.transient ? { ...chunk, transient: false } : chunk);
        },
      }),
    );
  }
}

/** Body of POST /api/internal-agent/chat (the API's ChatInput). */
export function chatRequestBody(messages: readonly AskOcsoMessage[], store: ChatStore) {
  const question = messages.findLast((m) => m.role === 'user');
  return {
    threadId: store.threadId,
    message: { role: 'user' as const, parts: (question?.parts ?? []).filter((p) => p.type === 'text') },
    context: store.context,
  };
}

export function createAskOcsoChat(options: {
  store: ChatStore;
  onThread: (threadId: string) => void;
  onFinish: ChatOnFinishCallback<AskOcsoMessage>;
  /** Injected in tests. */
  fetch?: typeof fetch;
}): Chat<AskOcsoMessage> {
  const { store } = options;
  return new Chat<AskOcsoMessage>({
    dataPartSchemas,
    transport: new AskOcsoTransport({
      api: '/api/internal-agent/chat',
      ...(options.fetch ? { fetch: options.fetch } : {}),
      prepareSendMessagesRequest: ({ messages }) => ({ body: chatRequestBody(messages, store) }),
    }),
    onData: (part) => {
      if (part.type !== 'data-thread') return;
      store.threadId = part.data.threadId;
      options.onThread(part.data.threadId);
    },
    onFinish: options.onFinish,
  });
}
