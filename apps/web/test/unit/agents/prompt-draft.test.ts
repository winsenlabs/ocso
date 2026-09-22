import { describe, expect, it } from 'vitest';
import type { PromptComponent } from '../../../components/agents/data/agent-schemas';
import { diffStats, lineDiff } from '../../../components/agents/lib/line-diff';
import { componentState, draftChanges, draftTexts, effectiveEdits, estimateTokens, mergeEdits } from '../../../components/agents/lib/prompt-draft';

const comp = (key: string, text: string | null): PromptComponent => ({ key, label: key, owner: key === 'runtime_contract' ? 'PLATFORM' : 'CS_LEAD', tag: key, help: '', text, tokens: text === null ? null : estimateTokens(text) });
const components = [comp('runtime_contract', null), comp('identity', 'You are Maya.'), comp('behavior', '• Be brief.'), comp('policies', '')];

describe('prompt draft state', () => {
  it('reads saved draft texts per business component, ignoring the platform contract', () => {
    const saved = draftTexts(components);
    expect(saved.identity).toBe('You are Maya.');
    expect(saved.business_context).toBe('');
    expect(Object.keys(saved)).not.toContain('runtime_contract');
  });

  it('merges only real edits over the saved draft', () => {
    const saved = draftTexts(components);
    const edits = { behavior: '• Be brief.\n• Offer the reversal path first.', identity: 'You are Maya.' };
    expect(effectiveEdits(saved, edits)).toEqual(['behavior']);
    const merged = mergeEdits(saved, edits);
    expect(merged.behavior).toContain('reversal path');
    expect(merged.identity).toBe('You are Maya.');
    expect(Object.keys(merged)).toHaveLength(8);
  });

  it('labels each component unsaved, draft or live', () => {
    const saved = draftTexts(components);
    const live = { identity: 'You are Maya.', behavior: '• Be concise.', policies: '' };
    expect(componentState('behavior', saved, live, {})).toBe('draft');
    expect(componentState('identity', saved, live, {})).toBe('live');
    expect(componentState('identity', saved, live, { identity: 'You are Maya, a colleague.' })).toBe('unsaved');
    expect(componentState('identity', saved, live, { identity: 'You are Maya.' })).toBe('live');
    expect(draftChanges(saved, live)).toEqual(['behavior']);
    expect(draftChanges(saved, null)).toEqual([]);
  });

  it('estimates tokens like the prompt compiler (~4 Latin characters per token, denser otherwise)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('नमस्ते')).toBe(4);
  });
});

describe('line diff', () => {
  it('keeps common lines and marks additions and removals', () => {
    const lines = lineDiff('a\nb\nc', 'a\nc\nd');
    expect(lines).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'same', text: 'c' },
      { kind: 'add', text: 'd' },
    ]);
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 });
  });

  it('handles empty sides', () => {
    expect(lineDiff('', 'x')).toEqual([{ kind: 'add', text: 'x' }]);
    expect(lineDiff('x', '')).toEqual([{ kind: 'del', text: 'x' }]);
    expect(lineDiff('', '')).toEqual([]);
  });

  it('degrades to remove-all/add-all on very large inputs instead of blocking', () => {
    const big = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n');
    const other = Array.from({ length: 600 }, (_, i) => `row ${i}`).join('\n');
    const stats = diffStats(lineDiff(big, other));
    expect(stats).toEqual({ added: 600, removed: 600 });
  });
});
