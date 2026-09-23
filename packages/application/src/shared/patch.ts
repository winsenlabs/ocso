import { z } from 'zod';

type Stripped<T> = T extends z.ZodDefault<infer Inner> ? Inner : T;
type PatchShape<S extends z.ZodRawShape> = { [K in keyof S]: z.ZodOptional<Stripped<S[K]>> };

/**
 * The PATCH form of a create schema: every field optional and NO defaults.
 * zod 4 applies `.default()` inside `.partial()`, so `Input.partial()` fills
 * every field the caller left out with its create-time default — a one-field
 * update would reset the rest (a channel's settings and status, a queue's
 * teams). Build every patch schema with this instead.
 */
export function patchOf<S extends z.ZodRawShape>(input: z.ZodObject<S>): z.ZodObject<PatchShape<S>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(input.shape)) {
    const inner = field instanceof z.ZodDefault ? (field.unwrap() as z.ZodType) : (field as z.ZodType);
    shape[key] = inner.optional();
  }
  return z.object(shape) as unknown as z.ZodObject<PatchShape<S>>;
}
