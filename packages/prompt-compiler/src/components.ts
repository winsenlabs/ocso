/**
 * Prompt component catalogue (docs/05 §1). Order here IS the compile order.
 * Stable components come first so provider prefix caches stay warm.
 */

/** Components a CS Lead edits per virtual agent (versioned in prompt_versions). */
export const BUSINESS_COMPONENT_KEYS = [
  'identity',
  'objective',
  'behavior',
  'policies',
  'tool_instructions',
  'escalation',
  'channel_constraints',
  'business_context',
] as const;
export type BusinessComponentKey = (typeof BUSINESS_COMPONENT_KEYS)[number];

export type PromptComponents = Readonly<Record<BusinessComponentKey, string>>;

export type ComponentOwner = 'PLATFORM' | 'CS_LEAD';

export interface ComponentDescriptor {
  key: BusinessComponentKey | 'runtime_contract';
  label: string;
  owner: ComponentOwner;
  /** Rendered XML-ish tag wrapping the component in the compiled system prompt. */
  tag: string;
  help: string;
}

export const COMPONENT_DESCRIPTORS: readonly ComponentDescriptor[] = [
  {
    key: 'runtime_contract',
    label: 'Runtime contract',
    owner: 'PLATFORM',
    tag: 'ocso_runtime_contract',
    help: 'Injected by OCSO. Turn structure, tool protocol, refusal handling, rendering rules.',
  },
  { key: 'identity', label: 'Identity', owner: 'CS_LEAD', tag: 'identity', help: 'Who the agent is and how it presents itself.' },
  { key: 'objective', label: 'Objective', owner: 'CS_LEAD', tag: 'objective', help: 'What a successful conversation achieves.' },
  { key: 'behavior', label: 'Behavior', owner: 'CS_LEAD', tag: 'behavior', help: 'How the agent conducts the conversation.' },
  {
    key: 'policies',
    label: 'Policies and compliance',
    owner: 'CS_LEAD',
    tag: 'policies',
    help: 'Rules that must never be broken. Authorization is still enforced in code.',
  },
  {
    key: 'tool_instructions',
    label: 'Tool instructions',
    owner: 'CS_LEAD',
    tag: 'tool_instructions',
    help: 'When and how to use tools. Tool schemas are owned by the Tech Admin via MCP approval.',
  },
  { key: 'escalation', label: 'Escalation rules', owner: 'CS_LEAD', tag: 'escalation_policy', help: 'When to hand off to a human and how to summarize.' },
  { key: 'channel_constraints', label: 'Channel constraints', owner: 'CS_LEAD', tag: 'channel_constraints', help: 'Your style and content rules per channel; OCSO adds each channel’s own length, formatting and media limits.' },
  {
    key: 'business_context',
    label: 'Business context',
    owner: 'CS_LEAD',
    tag: 'business_context',
    help: 'Stable organization facts: products, hours, published policies.',
  },
];

export function descriptorFor(key: string): ComponentDescriptor | undefined {
  return COMPONENT_DESCRIPTORS.find((d) => d.key === key);
}

export function emptyComponents(): Record<BusinessComponentKey, string> {
  return Object.fromEntries(BUSINESS_COMPONENT_KEYS.map((k) => [k, ''])) as Record<BusinessComponentKey, string>;
}

/** Keys whose values differ between two component sets (for version records). */
export function changedComponents(before: PromptComponents, after: PromptComponents): BusinessComponentKey[] {
  return BUSINESS_COMPONENT_KEYS.filter((k) => (before[k] ?? '') !== (after[k] ?? ''));
}
