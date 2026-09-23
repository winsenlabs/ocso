import type { Classification } from '@ocso/domain';
import type { ClassifyRequest, RouterClassifier } from '@ocso/application';
import { neutralize } from '@ocso/prompt-compiler';
import { z } from 'zod';
import type { ModelGateway } from '../model/gateway.js';

/**
 * CLASSIFY steps through the model gateway (PM/research/11 §5.3): the step's
 * profile, structured output `{label, confidence, followUp}` over the
 * customer's messages since routing started. Usage is recorded as CLASSIFIER.
 */

const Output = z.object({
  label: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  followUp: z.string().max(1_000).nullable(),
});

function responseSchema(values: readonly string[]): Record<string, unknown> {
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

export function classifierInstructions(request: Pick<ClassifyRequest, 'step'>): string {
  const { step } = request;
  const labels = step.labels.map((l) => `- ${l.value}: ${neutralize(l.description || l.value)}`).join('\n');
  return [
    'You route a customer to the right team. Read the customer messages and choose the one label that describes what they need.',
    `Labels:\n${labels}`,
    step.instructions.trim() ? `Guidance from the team:\n${neutralize(step.instructions.trim())}` : '',
    'Answer with JSON only: {"label": one of the label values or null, "confidence": a number from 0 to 1, "followUp": one short clarifying question to ask when you are not sure, else null}.',
    "Write the follow-up question in the customer's language. Never answer the customer's request yourself.",
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Structured output when the provider returned it, else the text parsed as JSON; unusable output = unclassified. */
export function parseClassification(structured: unknown, text: string): Classification {
  let raw: unknown = structured;
  if (raw === undefined || raw === null) {
    try {
      raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
      return { label: null, confidence: 0, followUp: null };
    }
  }
  const parsed = Output.safeParse(raw);
  return parsed.success ? parsed.data : { label: null, confidence: 0, followUp: null };
}

export function createRouterClassifier(gateway: ModelGateway): RouterClassifier {
  return async (request) => {
    const lines = request.transcript.map((m) => `${m.from === 'customer' ? 'Customer' : 'Menu'}: ${neutralize(m.text)}`).join('\n');
    const result = await gateway.run({
      profileId: request.step.modelProfileId,
      purpose: 'CLASSIFIER',
      system: [{ key: 'router_classifier', text: classifierInstructions(request), stable: true, breakpointAfter: 'AGENT_PREFIX' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: `<conversation>\n${lines || '(no messages)'}\n</conversation>` }] }],
      tools: [],
      responseSchema: responseSchema(request.step.labels.map((l) => l.value)),
      required: { structuredOutput: true },
      context: { correlationId: request.correlationId, conversationId: request.conversationId === 'simulation' ? null : request.conversationId, purpose: 'CLASSIFIER' },
    });
    return parseClassification(result.structured, result.text);
  };
}
