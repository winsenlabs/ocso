import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// 'use server' module bound to the API client; the components only need references.
vi.mock('../../../lib/actions/conversations', () => ({ setTagsAction: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/conversations/0199aa00-0000-7000-8000-000000000001',
  useSearchParams: () => new URLSearchParams('view=waiting&tag=emi'),
}));

const { TagsCard, TagEditor } = await import('../../../components/workspace/tag-editor');
const { InboxTagFilter } = await import('../../../components/workspace/inbox-tag-filter');
const { RowTags } = await import('../../../components/workspace/row-tags');

const state = (over: Partial<Parameters<typeof TagsCard>[0]['state']> = {}) => ({ tags: ['refund', 'emi'], pending: false, error: null, add: () => null, remove: () => undefined, ...over });

describe('rail Tags card', () => {
  it('renders chips that filter the inbox, remove buttons and "+ tag" for editors', () => {
    const html = renderToStaticMarkup(createElement(TagsCard, { state: state(), canEdit: true }));
    expect(html).toContain('aria-label="Tags"');
    expect(html).toContain('href="/conversations/0199aa00-0000-7000-8000-000000000001?view=waiting&amp;tag=refund"');
    expect(html).toContain('aria-label="Remove tag refund"');
    expect(html).toContain('aria-label="Remove tag emi"');
    expect(html).toMatch(/class="chip accent tagchip"><a [^>]*>emi<\/a>/);
    expect(html).toContain('+ tag');
    expect(html).toContain('>2<');
  });

  it('is read-only without the note permission and says when there are no tags', () => {
    const html = renderToStaticMarkup(createElement(TagsCard, { state: state({ tags: [] }), canEdit: false }));
    expect(html).toContain('No tags.');
    expect(html).not.toContain('+ tag');
    expect(html).not.toContain('Remove tag');
  });

  it('shows saving and API errors', () => {
    const html = renderToStaticMarkup(createElement(TagsCard, { state: state({ pending: true, error: 'Tags could not be saved' }), canEdit: true }));
    expect(html).toContain('saving…');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Tags could not be saved');
  });

  it('keeps the header variant compact when there are no tags', () => {
    const html = renderToStaticMarkup(createElement(TagEditor, { state: state({ tags: [] }), canEdit: true, place: 'header' }));
    expect(html).not.toContain('No tags');
    expect(html).toContain('+ tag');
  });
});

describe('inbox tags', () => {
  it('shows an active tag filter as a clearable chip, otherwise "+ tag"', () => {
    expect(renderToStaticMarkup(createElement(InboxTagFilter, { tag: 'refund', onChange: () => undefined }))).toMatch(/aria-pressed="true"[^>]*>tag · refund/);
    expect(renderToStaticMarkup(createElement(InboxTagFilter, { tag: null, onChange: () => undefined }))).toContain('+ tag');
  });

  it('renders up to three tag chips on a row, then +N, highlighting the filtered tag', () => {
    const html = renderToStaticMarkup(createElement(RowTags, { tags: ['refund', 'emi', 'vip', 'card', 'fee'], activeTag: 'emi' }));
    expect(html).toContain('class="rtags"');
    expect(html).toContain('<span class="chip">refund</span><span class="chip accent">emi</span><span class="chip">vip</span><span class="chip">+2</span>');
    expect(html).not.toContain('>card<');
    expect(renderToStaticMarkup(createElement(RowTags, { tags: [], activeTag: null }))).toBe('');
  });
});
