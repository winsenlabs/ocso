'use client';

import { useImperativeHandle, useRef, useState, type ClipboardEvent, type KeyboardEvent, type Ref } from 'react';
import { acceptAttribute, attachmentsEnabled, checkFile, kindOfMime, largestLimit } from '@/lib/webchat/files';
import type { LocalAttachment } from '@/lib/webchat/state';
import { formatBytes, type Translate } from '@/lib/webchat/strings';
import type { UploadResult, WebChatConfig } from '@/lib/webchat/types';

/**
 * Message composer: autosizing textarea (Enter sends, Shift+Enter breaks the
 * line), attachments uploaded as soon as they are picked or pasted (with
 * progress, per-file errors and previews), limits from the channel config.
 */

export interface ComposerHandle {
  focus(): void;
}

interface Upload {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  error: string | null;
  previewUrl: string | null;
  result: UploadResult | null;
  abort: AbortController;
}

export interface ComposerProps {
  config: WebChatConfig;
  placeholder: string;
  t: Translate;
  onSend: (text: string, attachments: LocalAttachment[]) => void;
  upload: (file: File, onProgress: (ratio: number) => void, signal: AbortSignal) => Promise<UploadResult>;
  ref?: Ref<ComposerHandle>;
}

let sequence = 0;

export function Composer({ config, placeholder, t, onSend, upload, ref }: ComposerProps) {
  const [text, setText] = useState('');
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => area.current?.focus() }), []);

  const canAttach = attachmentsEnabled(config);
  const over = text.length - config.maxTextLength;
  const busy = uploads.some((u) => u.status === 'uploading');
  const ready = uploads.filter((u) => u.status === 'done' && u.result);
  const canSend = !busy && over <= 0 && (text.trim().length > 0 || ready.length > 0);

  const patch = (id: string, change: Partial<Upload>) => setUploads((list) => list.map((u) => (u.id === id ? { ...u, ...change } : u)));

  function addFiles(files: File[]) {
    if (!files.length) return;
    setError(null);
    const room = config.maxAttachmentsPerMessage - uploads.length;
    if (files.length > room) setError(t('attachment.tooMany', { count: config.maxAttachmentsPerMessage }));
    for (const file of files.slice(0, Math.max(0, room))) {
      const check = checkFile(file, config);
      if (!check.ok) {
        setError(check.reason === 'type' ? t('attachment.typeNotAllowed', { name: file.name }) : t('attachment.tooLarge', { name: file.name, limit: formatBytes(check.limitBytes ?? 0) }));
        continue;
      }
      const item: Upload = {
        id: `u${++sequence}`,
        name: file.name || check.mimeType,
        mimeType: check.mimeType,
        size: file.size,
        progress: 0,
        status: 'uploading',
        error: null,
        previewUrl: check.kind === 'IMAGE' ? URL.createObjectURL(file) : null,
        result: null,
        abort: new AbortController(),
      };
      setUploads((list) => [...list, item]);
      upload(file, (ratio) => patch(item.id, { progress: ratio }), item.abort.signal).then(
        (result) => patch(item.id, { status: 'done', progress: 1, result }),
        (err: unknown) => {
          if ((err as Error).name === 'AbortError') return;
          patch(item.id, { status: 'error', error: t('attachment.failed', { name: item.name }) });
        },
      );
    }
  }

  function remove(item: Upload) {
    item.abort.abort();
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    setUploads((list) => list.filter((u) => u.id !== item.id));
  }

  function submit() {
    if (!canSend) return;
    const attachments: LocalAttachment[] = ready.map((u) => ({
      uploadId: u.result!.uploadId,
      mimeType: u.result!.mimeType,
      sizeBytes: u.result!.sizeBytes,
      filename: u.name,
      sha256: u.result!.sha256,
      previewUrl: u.previewUrl ?? undefined,
    }));
    onSend(text.trim(), attachments);
    setText('');
    setUploads((list) => list.filter((u) => u.status === 'error'));
    setError(null);
    if (area.current) area.current.style.height = '';
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (!canAttach) return;
    const files = Array.from(e.clipboardData.files);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  }

  return (
    <form
      className="wc-comp"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {uploads.length ? (
        <ul className="wc-tray" aria-label={t('composer.attach')}>
          {uploads.map((u) => (
            <li key={u.id} className={`wc-chip${u.status === 'error' ? ' err' : ''}`} aria-busy={u.status === 'uploading'}>
              {u.previewUrl ? <img src={u.previewUrl} alt="" /> : <span className="ph">{kindOfMime(u.mimeType).toUpperCase().slice(0, 3)}</span>}
              <span className="tx">
                <b>{u.name}</b>
                <span>{u.status === 'error' ? u.error : u.status === 'uploading' ? `${Math.round(u.progress * 100)}%` : formatBytes(u.size)}</span>
              </span>
              {u.status === 'uploading' ? (
                <span className="bar" role="progressbar" aria-label={t('attachment.uploading', { name: u.name })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(u.progress * 100)}>
                  <i style={{ width: `${Math.round(u.progress * 100)}%` }} />
                </span>
              ) : null}
              <button type="button" className="x" onClick={() => remove(u)} aria-label={t('attachment.remove', { name: u.name })}>
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="wc-err" role="alert">
          {error}
        </p>
      ) : null}
      <div className="wc-box">
        {canAttach ? (
          <>
            <button type="button" className="wc-icon-btn" onClick={() => picker.current?.click()} aria-label={t('composer.attach')} title={t('attachment.accepts', { limit: formatBytes(largestLimit(config)) })}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M13.5 6.5l-5.8 5.8a1.6 1.6 0 002.3 2.3l6.1-6.1a3.2 3.2 0 00-4.5-4.5L5.3 10.3a4.8 4.8 0 006.8 6.8l5.1-5.1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            <input
              ref={picker}
              type="file"
              hidden
              multiple
              accept={acceptAttribute(config)}
              data-testid="wc-file-input"
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
          </>
        ) : null}
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={t('composer.label')}
          aria-describedby="wc-hint"
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <button type="submit" className="wc-send" disabled={!canSend} aria-label={t('composer.send')}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 10h11M10 4.5l5.5 5.5-5.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
      <div className="wc-hint" id="wc-hint">
        <span className="kb">{t('composer.hint')}</span>
        {over > 0 ? <span className="over">{t('composer.tooLong', { count: over })}</span> : null}
      </div>
    </form>
  );
}

