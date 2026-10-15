import { neutralize } from '../common/neutralize.js';
import type { ClassifyStep, RouterPersona } from './router-definition.js';

/**
 * What a CLASSIFY step sends the model (PM/research/11 §5.3), in one place: the server builds the call from it and
 * the router builder shows it, so what a team reviews is exactly what the model receives.
 */
export function classifierInstructions(step: Pick<ClassifyStep, 'labels' | 'instructions'>, persona: RouterPersona | null | undefined): string {
  const labels = step.labels.map((l) => `- ${l.value}: ${neutralize(l.description || l.value)}`).join('\n');
  const who = persona
    ? `You are ${neutralize(persona.name)}, the first to greet customers. You route each customer to the right team; you never answer their request yourself.${persona.voice.trim() ? `\nYour voice: ${neutralize(persona.voice.trim())}` : ''}`
    : 'You route a customer to the right team. Read the customer messages and choose the one label that describes what they need.';
  return [
    who,
    persona ? 'Read the customer messages and choose the one label that describes what they need.' : '',
    `Labels:\n${labels}`,
    step.instructions.trim() ? `Guidance from the team:\n${neutralize(step.instructions.trim())}` : '',
    'Answer with JSON only: {"label": one of the label values or null, "confidence": a number from 0 to 1, "followUp": one short clarifying question to ask when you are not sure, else null}.',
    persona
      ? `Write the follow-up question in the customer's language, in your own voice as ${neutralize(persona.name)}. Never answer the customer's request yourself.`
      : "Write the follow-up question in the customer's language. Never answer the customer's request yourself.",
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The user turn: the conversation so far, customer lines and the router's own messages, oldest first. */
export function classifierTranscript(transcript: ReadonlyArray<{ from: 'customer' | 'router'; text: string }>): string {
  const lines = transcript.map((m) => `${m.from === 'customer' ? 'Customer' : 'Menu'}: ${neutralize(m.text)}`).join('\n');
  return `<conversation>\n${lines || '(no messages)'}\n</conversation>`;
}

/** The structured answer the model must return, for a step's labels (JSON Schema). */
export function classifierResponseSchema(values: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      label: { anyOf: [{ type: 'string', enum: [...values] }, { type: 'null' }] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      followUp: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
    required: ['label', 'confidence', 'followUp'],
    additionalProperties: false,
  };
}
