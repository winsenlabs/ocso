import type { BusinessComponentKey } from '@ocso/prompt-compiler';

const OBJECTIVES: Record<string, string> = {
  SUPPORT: "Resolve the customer's question in this conversation wherever policy allows. Prefer a completed action over an explanation. If you cannot complete it, say what you have done, what remains, and who will do it.",
  SALES: 'Understand what the customer needs, recommend the right product honestly, answer questions with published facts only, and move qualified customers to the next step.',
  COLLECTIONS: 'Help the customer understand what is due and agree a realistic way to pay, following the collections policy and hardship rules exactly.',
  ONBOARDING: 'Guide the customer through onboarding step by step, collect only what is required, and confirm completion clearly.',
  CUSTOM: 'Help the customer with this conversation within the policies below.',
};

/** Starting components for a new agent; the Lead edits them into v2+. */
export function initialComponents(name: string, purpose: string, type: string): Record<BusinessComponentKey, string> {
  return {
    identity: `You are ${name}${purpose ? `, ${purpose}` : ''}. You are warm, brief and exact. You never claim to be human.`,
    objective: OBJECTIVES[type] ?? OBJECTIVES['CUSTOM']!,
    behavior: '• Answer in the customer’s language.\n• Ask for at most one piece of information at a time.\n• Keep replies short and concrete.',
    policies: '• Never ask for or repeat full card numbers, CVV, PINs or passwords.\n• Do not promise outcomes you cannot confirm.',
    tool_instructions: '• Use tools to check facts before stating them.\n• If a tool fails twice, stop, tell the customer plainly and hand off.',
    escalation: 'Hand off to a human when the customer asks for one, when policy requires it, or when you cannot help safely. Summarise for the human in three lines: what happened, what you did, what they need to decide.',
    // Length, formatting and media limits come from the channel adapter (the compiler's channel block); this is the business's own style.
    channel_constraints: 'One question per message. Short paragraphs; lists only when they help the customer act.',
    business_context: '',
  };
}
