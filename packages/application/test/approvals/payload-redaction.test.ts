import { describe, expect, it } from 'vitest';
import { sanitizeForAudit } from '@ocso/tools';
import { createApprovalRegistry } from '../../src/approvals/index.js';

/**
 * A proposal's payload is replayed on activation, so it is stored raw and
 * never returned over HTTP. The compensating rule: it never carries a secret
 * value (only a secretRef). If redaction would change a descriptor's sample
 * payload, that payload carries a secret — fix the descriptor.
 */
const SAMPLES: Record<string, Record<string, unknown>> = {
  agent: {
    name: 'Maya',
    purpose: 'Cards and EMI support',
    modelProfileId: '01a0cd12-87fc-71e6-85ff-7b598bcdf97b',
    maxToolSteps: 4,
    businessHours: { timezone: 'Asia/Kolkata', humanHours: { mon: ['09:00', '18:00'] } },
    channelIds: ['01a0cd12-87fc-71e6-85ff-7b598bcdf97c'],
    multimodal: { imageInput: true, documentInput: true, audioInput: false, maxMediaPerTurn: 4 },
  },
  prompt_version: {},
};

describe('approval payloads carry no secrets', () => {
  const registry = createApprovalRegistry();

  it('has a sample for every kind', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...registry.kinds()].sort());
  });

  it.each(Object.entries(SAMPLES))('%s: the parsed sample survives redaction unchanged', (kind, sample) => {
    const d = registry.get(kind);
    const parsed = d.payload ? (d.payload.parse(sample) as Record<string, unknown>) : sample;
    expect(sanitizeForAudit(parsed)).toEqual(parsed);
  });
});
