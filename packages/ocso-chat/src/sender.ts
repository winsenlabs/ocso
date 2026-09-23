import { ChatApiError, fileName, isNativeFile, mimeTypeOf, type ChatApi } from './api.js';
import { abortError, objectUrl, revokeObjectUrl, sleep, type AbortSignalLike } from './platform.js';
import type { CoreAction, CoreState, LocalAttachment, PendingSend } from './reducer.js';
import { backoffDelay } from './sse.js';
import type { AttachmentInput, UploadResult } from './types.js';
import type { OutgoingMessage } from './wire.js';

/**
 * Outgoing messages: optimistic entry → uploads → `POST /messages`
 * (idempotent by clientMessageId, retried with backoff, one token refresh on
 * 401) → marked sent or failed. Mirrors the widget's transport.
 */

export interface SenderDeps {
  api: ChatApi;
  token: () => Promise<string>;
  refresh: () => Promise<unknown>;
  dispatch: (action: CoreAction) => void;
  getState: () => CoreState;
  maxAttempts?: number;
}

/** A receipt from `upload()` (already stored by OCSO), as opposed to a file still to upload. */
export function isUploaded(item: AttachmentInput | UploadResult): item is UploadResult {
  return typeof (item as UploadResult).uploadId === 'string' && (item as UploadResult).uploadId.length > 0;
}

/** Upload one file, retrying transient failures (a 401 refreshes the token once). Aborting `signal` stops it. */
export async function uploadFile(deps: SenderDeps, file: AttachmentInput, signal?: AbortSignalLike): Promise<UploadResult> {
  const receipt = await withRetries(deps, (token) => deps.api.upload(token, file, signal), signal);
  return { ...receipt, filename: fileName(file) };
}

async function withRetries<T>(deps: SenderDeps, run: (token: string) => Promise<T>, signal?: AbortSignalLike): Promise<T> {
  const max = deps.maxAttempts ?? 4;
  let refreshed = false;
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw abortError();
    try {
      return await run(await deps.token());
    } catch (err) {
      if (signal?.aborted || (err as Error)?.name === 'AbortError') throw err;
      const apiError = err instanceof ChatApiError ? err : new ChatApiError(0, 'network', (err as Error)?.message ?? 'Network unavailable');
      if (apiError.status === 401 && !refreshed) {
        refreshed = true;
        await deps.refresh().catch(() => undefined);
        continue;
      }
      if (apiError.retriable && attempt < max) {
        await sleep(Math.max(apiError.retryAfterMs ?? 0, backoffDelay(attempt, { baseMs: 800, maxMs: 8_000, jitter: 0.3 })), signal);
        continue;
      }
      throw apiError;
    }
  }
}

function toOutgoing(pending: PendingSend): OutgoingMessage {
  const text = pending.text.trim();
  return {
    clientMessageId: pending.clientMessageId,
    ...(text ? { text } : {}),
    attachments: pending.attachments.map((a) => ({
      uploadId: a.uploadId,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      filename: a.filename,
      ...(a.sha256 ? { sha256: a.sha256 } : {}),
    })),
    ...(pending.structured ? { structured: pending.structured } : {}),
  };
}

export function placeholder(file: AttachmentInput | UploadResult): LocalAttachment {
  if (isUploaded(file)) {
    return { uploadId: file.uploadId, mimeType: file.mimeType, sizeBytes: file.sizeBytes, filename: file.filename || 'attachment', ...(file.sha256 ? { sha256: file.sha256 } : {}) };
  }
  const filename = fileName(file);
  return {
    uploadId: '',
    mimeType: mimeTypeOf({ name: filename, type: file.type }),
    sizeBytes: isNativeFile(file) ? 0 : file.size,
    filename,
    previewUrl: isNativeFile(file) ? file.uri : objectUrl(file),
  };
}

/** Upload what is not uploaded yet, then POST the message. Throws after marking it failed. */
export async function deliver(deps: SenderDeps, clientMessageId: string, files: ReadonlyArray<AttachmentInput | null>): Promise<void> {
  const current = () => deps.getState().pending.find((p) => p.clientMessageId === clientMessageId);
  try {
    const start = current();
    if (!start) return;
    const attachments = [...start.attachments];
    for (let i = 0; i < attachments.length; i++) {
      const a = attachments[i] as LocalAttachment;
      const file = files[i];
      if (a.uploadId || !file) continue;
      const receipt = await uploadFile(deps, file);
      attachments[i] = { ...a, uploadId: receipt.uploadId, mimeType: receipt.mimeType, sizeBytes: receipt.sizeBytes, ...(receipt.sha256 ? { sha256: receipt.sha256 } : {}) };
      const latest = current();
      if (!latest) return;
      deps.dispatch({ type: 'send', pending: { ...latest, attachments: [...attachments] } });
    }
    const ready = current();
    if (!ready) return;
    if (ready.attachments.some((a) => !a.uploadId)) throw new ChatApiError(0, 'attachment_missing', 'An attachment could not be read');
    const result = await withRetries(deps, (token) => deps.api.send(token, toOutgoing(ready)));
    for (const a of ready.attachments) if (a.previewUrl?.startsWith('blob:')) scheduleRevoke(deps, clientMessageId, a.previewUrl);
    deps.dispatch({ type: 'sent', clientMessageId, interactionId: result.interactionId, conversationId: result.conversationId });
  } catch (err) {
    const code = err instanceof ChatApiError ? err.code : 'send_failed';
    deps.dispatch({ type: 'send-failed', clientMessageId, error: code });
    throw err;
  }
}

/** Keep a local preview until the stored copy (with its signed URL) replaced it, then free it. */
function scheduleRevoke(deps: SenderDeps, clientMessageId: string, url: string): void {
  let tries = 0;
  const check = () => {
    tries += 1;
    const stillPending = deps.getState().pending.some((p) => p.clientMessageId === clientMessageId);
    if (!stillPending || tries > 60) revokeObjectUrl(url);
    else void sleep(5_000).then(check);
  };
  void sleep(5_000).then(check);
}
