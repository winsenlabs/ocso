import { classifierInstructions, classifierResponseSchema, classifierTranscript, type Classification } from '@ocso/domain';
import type { RouterClassifier } from '@ocso/application';
import { z } from 'zod';
import type { ModelGateway } from '../model/gateway.js';

/**
 * CLASSIFY steps through the model gateway (PM/research/11 §5.3): the step's
 * profile, structured output `{label, confidence, followUp}` over the
 * customer's messages since routing started, in the router's persona when it
 * has one. Usage is recorded as CLASSIFIER.
 */

const Output = z.object({
  label: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  followUp: z.string().max(1_000).nullable(),
});

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
    const result = await gateway.run({
      profileId: request.step.modelProfileId,
      purpose: 'CLASSIFIER',
      // The builder previews exactly these (@ocso/domain router-prompt).
      system: [{ key: 'router_classifier', text: classifierInstructions(request.step, request.persona), stable: true, breakpointAfter: 'AGENT_PREFIX' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: classifierTranscript(request.transcript) }] }],
      tools: [],
      responseSchema: classifierResponseSchema(request.step.labels.map((l) => l.value)),
      required: { structuredOutput: true },
      context: { correlationId: request.correlationId, conversationId: request.conversationId === 'simulation' ? null : request.conversationId, purpose: 'CLASSIFIER' },
    });
    return parseClassification(result.structured, result.text);
  };
}
