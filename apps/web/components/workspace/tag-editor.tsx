'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import type { ConversationTags } from './lib/use-conversation-tags';
import { hrefWithTag, tagParam } from './lib/tags';
import { TagInput } from './tag-input';

export interface TagEditorProps {
  state: ConversationTags;
  canEdit: boolean;
  /** Rail card (wide screens) or conversation header (when the rail is hidden). */
  place: 'rail' | 'header';
}

/**
 * Tag chips (design/01 rail "Tags": chips + "+ tag"). A chip's label filters
 * the inbox by that tag; × removes it; "+ tag" opens autocomplete.
 */
export function TagEditor({ state, canEdit, place }: TagEditorProps) {
  const [adding, setAdding] = useState(false);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filtered = tagParam(searchParams.get('tag'));
  const { tags } = state;
  return (
    <>
      <div className="tag-row" data-place={place}>
        {tags.length === 0 && !adding && place === 'rail' ? <span className="mono-sm">{canEdit ? 'No tags yet.' : 'No tags.'}</span> : null}
        {tags.map((t) => (
          <span className={t === filtered ? 'chip accent tagchip' : 'chip tagchip'} key={t}>
            <Link href={hrefWithTag(pathname, searchParams.toString(), t)} title={`Show conversations tagged “${t}” in the inbox`}>
              {t}
            </Link>
            {canEdit ? (
              <button type="button" aria-label={`Remove tag ${t}`} onClick={() => state.remove(t)}>
                ×
              </button>
            ) : null}
          </span>
        ))}
        {canEdit && !adding ? (
          <button type="button" className="btn tiny ghost" onClick={() => setAdding(true)}>
            + tag
          </button>
        ) : null}
      </div>
      {canEdit && adding ? <TagInput label="Add tag" present={tags} onAdd={state.add} onDone={() => setAdding(false)} autoFocus /> : null}
      {state.error ? (
        <span className="tag-err" role="alert">
          {state.error}
        </span>
      ) : null}
    </>
  );
}

/** Rail card around the editor. */
export function TagsCard({ state, canEdit }: Omit<TagEditorProps, 'place'>) {
  return (
    <section className="rcard" aria-label="Tags">
      <h3>
        Tags<span className="sp" />
        <span className="mono-sm" aria-live="polite">
          {state.pending ? 'saving…' : state.tags.length || ''}
        </span>
      </h3>
      <TagEditor state={state} canEdit={canEdit} place="rail" />
    </section>
  );
}
