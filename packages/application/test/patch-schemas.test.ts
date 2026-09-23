import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as application from '@ocso/application';
import { patchOf } from '@ocso/application';

/**
 * A PATCH carries only the fields the caller changes. zod 4 applies `.default()`
 * inside `.partial()`, which once turned "set the default agent" into "and wipe
 * the channel's settings and set it to DRAFT". Every exported *Patch schema must
 * leave absent fields absent.
 */
const patchSchemas = Object.entries(application as Record<string, unknown>).flatMap(([name, value]): Array<[string, z.ZodType]> =>
  name.endsWith('Patch') && value instanceof z.ZodType ? [[name, value]] : [],
);

describe('patch schemas', () => {
  it('finds the patch schemas', () => {
    expect(patchSchemas.map(([name]) => name)).toEqual(expect.arrayContaining(['ChannelPatch', 'QueuePatch', 'EscalationRulePatch', 'AgentPatch']));
  });

  it.each(patchSchemas)('%s fills in nothing the caller left out', (_name, schema) => {
    expect(schema.parse({})).toEqual({});
  });

  it('patchOf keeps validation but drops defaults', () => {
    const Input = z.object({ name: z.string().min(1), status: z.enum(['ACTIVE', 'DRAFT']).default('DRAFT'), tags: z.array(z.string()).default([]) });
    const Patch = patchOf(Input);
    expect(Patch.parse({ tags: ['a'] })).toEqual({ tags: ['a'] });
    expect(Patch.safeParse({ name: '' }).success).toBe(false);
    expect(Patch.safeParse({ status: 'GONE' }).success).toBe(false);
  });
});
