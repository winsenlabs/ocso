'use client';

import { useId, useState, type KeyboardEvent } from 'react';
import { freshSuggestions, moveActive } from './lib/tags';
import { useTagSuggestions } from './lib/use-tag-suggestions';

export interface TagInputProps {
  /** Accessible name of the text box. */
  label: string;
  /** For a visible <label htmlFor>. */
  id?: string;
  /** Tags already chosen: never suggested again. */
  present: readonly string[];
  /** Add a tag (raw text or a suggestion); return an error message to keep the text and show it. */
  onAdd: (raw: string) => string | null;
  /** Escape on an empty box, or leaving it empty. */
  onDone?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Suggestions flow in the layout (dialogs) instead of floating over it. */
  inline?: boolean;
}

/**
 * Tag combobox with autocomplete from the most used tags. Enter or "," adds
 * the highlighted suggestion or the typed text; arrows move through the list.
 */
export function TagInput({ label, id, present, onAdd, onDone, placeholder = 'add a tag', autoFocus, inline }: TagInputProps) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();
  const options = freshSuggestions(useTagSuggestions(text, focused), present);
  const open = focused && options.length > 0;

  const add = (raw: string) => {
    if (!raw.trim()) return;
    const problem = onAdd(raw);
    setError(problem);
    if (!problem) {
      setText('');
      setActive(-1);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!options.length) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => moveActive(i, step, options.length));
      return;
    }
    if (e.key === 'Enter' || e.key === ',') {
      const pick = active >= 0 ? options[active]?.tag : undefined;
      if (!pick && !text.trim()) return; // let Enter submit the surrounding form
      e.preventDefault();
      add(pick ?? text);
      return;
    }
    if (e.key === 'Escape') {
      // Handled here, so a surrounding dialog (listening on document, like React) must not close too.
      const swallow = () => {
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
      };
      if (open && active >= 0) {
        swallow();
        setActive(-1);
      } else if (text) {
        swallow();
        setText('');
        setError(null);
      } else if (onDone) {
        swallow();
        onDone();
      }
    }
  };

  return (
    <div className={inline ? 'tag-input inline' : 'tag-input'}>
      <input
        id={id}
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        aria-invalid={error ? true : undefined}
        value={text}
        maxLength={60}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => {
          setText(e.target.value);
          setActive(-1);
          setError(null);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setActive(-1);
          if (!text.trim()) onDone?.();
        }}
        onKeyDown={onKeyDown}
      />
      {open ? (
        <ul className="tag-suggest" role="listbox" id={listId} aria-label={`${label} suggestions`}>
          {options.map((o, i) => (
            <li
              key={o.tag}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'on' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => add(o.tag)}
            >
              <span>{o.tag}</span>
              <span className="n">{o.count}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <span className="tag-err" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
