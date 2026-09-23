'use client';

import type { ChoiceOption } from '@winsendotai/ocso-chat';
import { useState } from 'react';
import { useOcsoChatClient } from '../core/context.js';
import { latestChoices, useOcsoChatState } from '../core/hooks.js';
import { cx, defaultLabels, type OcsoChatClassNames } from './shared.js';

export interface ChoiceButtonsProps {
  /** Options to show; default: the latest message's choices (nothing when the customer already replied). */
  options?: ChoiceOption[];
  prompt?: string | undefined;
  disabled?: boolean;
  /** Called instead of sending the choice. */
  onChoose?: (choice: ChoiceOption) => void;
  classNames?: OcsoChatClassNames;
  label?: string;
}

/** Tappable answers to a question from the assistant (sent back as a structured reply with the option id). */
export function ChoiceButtons(props: ChoiceButtonsProps) {
  const client = useOcsoChatClient();
  const latest = useOcsoChatState((s) => (props.options ? null : latestChoices(s.messages)));
  const [picked, setPicked] = useState<{ key: string; id: string } | null>(null);
  const key = latest?.messageId ?? 'props';
  const chosen = picked?.key === key ? picked.id : null;
  const setChosen = (id: string | null) => setPicked(id ? { key, id } : null);
  const options = props.options ?? latest?.options ?? [];
  const prompt = props.options ? props.prompt : latest?.prompt;
  if (!options.length) return null;
  const choose = (choice: ChoiceOption) => {
    setChosen(choice.id);
    if (props.onChoose) props.onChoose(choice);
    else void client.sendChoice(choice).catch(() => setChosen(null));
  };
  return (
    <div role="group" aria-label={prompt ?? props.label ?? defaultLabels.choicesGroup} className={cx('ocso-chat__choices', props.classNames?.choices)}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={cx('ocso-chat__choice', props.classNames?.choice)}
          disabled={props.disabled || chosen !== null}
          aria-pressed={chosen === option.id}
          onClick={() => choose(option)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
