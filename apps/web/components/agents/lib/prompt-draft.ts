import { COMPONENT_KEYS, type ComponentKey, type PromptComponent } from '../data/agent-schemas';

/**
 * Prompt editor state (docs/05): the server keeps one saved draft per agent;
 * the browser holds unsaved edits on top of it. Pure helpers, client-safe.
 */

export type ComponentState = 'unsaved' | 'draft' | 'live';
export type Edits = Partial<Record<ComponentKey, string>>;

export const isComponentKey = (key: string): key is ComponentKey => (COMPONENT_KEYS as readonly string[]).includes(key);

/**
 * Display estimate only, identical to packages/prompt-compiler estimateTokens
 * (~4 characters per token for Latin text, denser for other scripts). Real
 * counts come from provider usage.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 128) ascii++;
  return Math.ceil(ascii / 4 + (text.length - ascii) / 1.5);
}

/** Saved draft text per business component. */
export function draftTexts(components: readonly PromptComponent[]): Record<ComponentKey, string> {
  const out = Object.fromEntries(COMPONENT_KEYS.map((k) => [k, ''])) as Record<ComponentKey, string>;
  for (const c of components) if (isComponentKey(c.key)) out[c.key] = c.text ?? '';
  return out;
}

/** The full component set to PUT: saved draft with unsaved edits applied. */
export function mergeEdits(saved: Record<ComponentKey, string>, edits: Edits): Record<ComponentKey, string> {
  const out = { ...saved };
  for (const key of COMPONENT_KEYS) {
    const edit = edits[key];
    if (edit !== undefined) out[key] = edit;
  }
  return out;
}

/** Edits that actually differ from the saved draft. */
export function effectiveEdits(saved: Record<ComponentKey, string>, edits: Edits): ComponentKey[] {
  return COMPONENT_KEYS.filter((k) => edits[k] !== undefined && edits[k] !== saved[k]);
}

/** unsaved = edited in the browser; draft = saved draft differs from the live version; live = same as live. */
export function componentState(key: ComponentKey, saved: Record<ComponentKey, string>, live: Readonly<Record<string, string>> | null, edits: Edits): ComponentState {
  const edit = edits[key];
  if (edit !== undefined && edit !== saved[key]) return 'unsaved';
  if (live && (live[key] ?? '') !== saved[key]) return 'draft';
  return 'live';
}

/** Components whose saved draft differs from the live version. */
export function draftChanges(saved: Record<ComponentKey, string>, live: Readonly<Record<string, string>> | null): ComponentKey[] {
  if (!live) return [];
  return COMPONENT_KEYS.filter((k) => (live[k] ?? '') !== saved[k]);
}
