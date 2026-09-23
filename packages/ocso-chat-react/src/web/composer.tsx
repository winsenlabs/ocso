'use client';

import { acceptedMimeTypes, attachmentsEnabled, checkAttachment, type AttachmentInput } from '@winsendotai/ocso-chat';
import { useId, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { useOcsoChat } from '../core/hooks.js';
import { cx, defaultLabels, type OcsoChatClassNames, type OcsoChatLabels } from './shared.js';

export interface ComposerProps {
  classNames?: OcsoChatClassNames;
  labels?: Partial<OcsoChatLabels>;
  placeholder?: string;
  /** Show the attach button (default: when the channel accepts attachments). */
  allowAttachments?: boolean;
  /** Focus the input on mount. */
  autoFocus?: boolean;
}

function nameOf(file: AttachmentInput): string {
  return file.name ?? 'attachment';
}

/**
 * Labelled message input. Enter sends, Shift+Enter adds a line; files are
 * checked against the channel's limits before they are staged.
 */
export function Composer({ classNames, labels: labelOverrides, placeholder, allowAttachments, autoFocus }: ComposerProps) {
  const chat = useOcsoChat();
  const labels = { ...defaultLabels, ...labelOverrides };
  const [problem, setProblem] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const inputId = useId();
  const config = chat.config;
  const canAttach = allowAttachments ?? (config ? attachmentsEnabled(config) : false);
  const maxFiles = config?.maxAttachmentsPerMessage ?? 0;
  const disabled = chat.status === 'error';

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void chat.handleSubmit();
    }
  };

  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    setProblem(null);
    const accepted: AttachmentInput[] = [];
    for (const file of picked) {
      const check = config ? checkAttachment(file, config) : ({ ok: true } as const);
      if (!check.ok) {
        setProblem(check.reason === 'size' ? labels.fileTooLarge : labels.fileTypeNotAllowed);
        continue;
      }
      accepted.push(file);
    }
    const next = [...chat.attachments, ...accepted];
    if (maxFiles && next.length > maxFiles) setProblem(labels.tooManyFiles(maxFiles));
    chat.setAttachments(maxFiles ? next.slice(0, maxFiles) : next);
  };

  return (
    <form className={cx('ocso-chat__composer', classNames?.composer)} onSubmit={(e) => void chat.handleSubmit(e)}>
      {chat.attachments.length ? (
        <ul className="ocso-chat__attachments">
          {chat.attachments.map((file, i) => (
            <li key={`${nameOf(file)}-${i}`} className={cx('ocso-chat__attachment', classNames?.attachment)}>
              <span>{nameOf(file)}</span>
              <button type="button" aria-label={labels.removeAttachment(nameOf(file))} onClick={() => chat.setAttachments(chat.attachments.filter((_, j) => j !== i))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {problem ? (
        <p role="alert" className={cx('ocso-chat__error', classNames?.error)}>
          {problem}
        </p>
      ) : null}
      <div className="ocso-chat__composer-row">
        {canAttach ? (
          <>
            <input ref={fileInput} type="file" multiple hidden tabIndex={-1} accept={config ? acceptedMimeTypes(config).join(',') : undefined} onChange={onFiles} />
            <button type="button" className={cx('ocso-chat__attach', classNames?.attach)} aria-label={labels.attach} disabled={disabled} onClick={() => fileInput.current?.click()}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path fill="currentColor" d="M16.5 6.5v10a4.5 4.5 0 0 1-9 0V5a3 3 0 0 1 6 0v10.5a1.5 1.5 0 0 1-3 0V6.5H9v9a3 3 0 0 0 6 0V5a4.5 4.5 0 0 0-9 0v11.5a6 6 0 0 0 12 0v-10h-1.5z" />
              </svg>
            </button>
          </>
        ) : null}
        <label htmlFor={inputId} className="ocso-chat__sr-only">
          {labels.input}
        </label>
        <textarea
          id={inputId}
          className={cx('ocso-chat__input', classNames?.input)}
          rows={1}
          value={chat.input}
          placeholder={placeholder ?? labels.placeholder}
          maxLength={config?.maxTextLength}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => chat.setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="submit" className={cx('ocso-chat__send', classNames?.send)} disabled={disabled || (!chat.input.trim() && !chat.attachments.length)}>
          {labels.send}
        </button>
      </div>
    </form>
  );
}
