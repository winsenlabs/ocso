import type { CoreAction, CoreState } from './reducer.js';
import type { ChatEvents, ChatState } from './types.js';
import { messageId } from './view.js';
import type { LiveEvent } from './wire.js';

/** Live stream events → state changes and client events (`message` / `notice` fire once, for live arrivals). */

export interface LiveEventTarget {
  core(): CoreState;
  snapshot(): ChatState;
  dispatch(action: CoreAction): void;
  emit<E extends keyof ChatEvents>(event: E, payload: ChatEvents[E]): void;
  /** Every (re)connect: fetch what was missed. */
  gapFill(): Promise<void>;
}

export function applyLiveEvent(t: LiveEventTarget, event: LiveEvent): void {
  const now = Date.now();
  switch (event.event) {
    case 'ready':
      void t.gapFill().catch(() => undefined);
      break;
    case 'message': {
      const known = t.core().messages.some((m) => m.id === event.data.id);
      t.dispatch({ type: 'message', message: event.data });
      if (!known && event.data.from !== 'customer') {
        const message = t.snapshot().messages.find((m) => m.id === messageId.message(event.data.id));
        if (message) t.emit('message', message);
      }
      break;
    }
    case 'delta':
      t.dispatch({ type: 'delta', turnId: event.data.turnId, text: event.data.text, now });
      break;
    case 'typing':
      t.dispatch({ type: 'typing', turnId: event.data.turnId, status: event.data.status, now });
      break;
    case 'idle':
      t.dispatch({ type: 'idle', turnId: event.data.turnId });
      break;
    case 'notice': {
      const known = t.core().notices.some((n) => n.id === event.data.id);
      t.dispatch({ type: 'notice', notice: event.data });
      if (!known) t.emit('notice', { id: event.data.id, kind: event.data.kind, name: event.data.name, at: event.data.at });
      break;
    }
    case 'status':
      t.dispatch({ type: 'status', status: event.data });
      break;
    default:
      break;
  }
}
