'use client';

import { useState } from 'react';
import { tagParam } from './lib/tags';
import { TagInput } from './tag-input';

export interface InboxTagFilterProps {
  tag: string | null;
  onChange: (tag: string | null) => void;
}

/** Inbox tag filter chip: "Tag" opens autocomplete; an active filter shows the tag and clears on click. */
export function InboxTagFilter({ tag, onChange }: InboxTagFilterProps) {
  const [editing, setEditing] = useState(false);
  if (tag) {
    return (
      <button type="button" className="fchip active tag-filter" aria-pressed="true" aria-label={`Tag filter ${tag}, click to clear`} onClick={() => onChange(null)}>
        tag · {tag}
        <span aria-hidden="true">×</span>
      </button>
    );
  }
  if (editing) {
    return (
      <TagInput
        label="Filter by tag"
        present={[]}
        placeholder="tag"
        autoFocus
        onDone={() => setEditing(false)}
        onAdd={(raw) => {
          const next = tagParam(raw);
          if (!next) return 'Not a valid tag';
          setEditing(false);
          onChange(next);
          return null;
        }}
      />
    );
  }
  return (
    <button type="button" className="fchip" onClick={() => setEditing(true)}>
      + tag
    </button>
  );
}
