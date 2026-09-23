import { z } from 'zod';

/**
 * zod → form-field descriptors, so the admin UI can render a provider's
 * settings and credential forms from the adapter's own schemas (no per-provider
 * UI code). Built on zod's JSON Schema export (input side: defaulted fields are
 * optional). Nested objects and records are exposed as `json` fields.
 */
export type ProviderFieldType = 'string' | 'url' | 'integer' | 'number' | 'boolean' | 'enum' | 'json';

export interface ProviderFieldDescriptor {
  name: string;
  label: string;
  type: ProviderFieldType;
  required: boolean;
  /** Credential fields: write-only in the UI, stored in the SecretStore. */
  secret: boolean;
  description?: string | undefined;
  options?: string[] | undefined;
  default?: unknown;
  pattern?: string | undefined;
  min?: number | undefined;
  max?: number | undefined;
}

interface JsonSchemaNode {
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  default?: unknown;
  description?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  anyOf?: JsonSchemaNode[];
}

/** `accessKeyId` → `Access key id`; `baseURL` → `Base URL`. */
export function humanizeFieldName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w, i) => (/^[A-Z0-9]{2,}$/.test(w) ? w : i === 0 ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()));
  return words.join(' ');
}

/** The non-null branch of `anyOf: [X, {type: 'null'}]` (nullable fields). */
function unwrapNullable(node: JsonSchemaNode): JsonSchemaNode {
  if (!node.anyOf) return node;
  const concrete = node.anyOf.filter((n) => n.type !== 'null');
  return concrete.length === 1 ? { ...concrete[0], ...(node.default !== undefined ? { default: node.default } : {}) } : node;
}

function fieldType(node: JsonSchemaNode): ProviderFieldType {
  if (node.enum) return 'enum';
  const type = Array.isArray(node.type) ? node.type.find((t) => t !== 'null') : node.type;
  if (type === 'string') return node.format === 'uri' || node.format === 'url' ? 'url' : 'string';
  if (type === 'integer' || type === 'number' || type === 'boolean') return type;
  return 'json';
}

function toJsonSchema(schema: z.ZodType): JsonSchemaNode {
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchemaNode;
  } catch {
    // Schemas with constructs JSON Schema cannot express still get a generic form.
    return { type: 'object', properties: {} };
  }
}

/** Describe the top-level fields of an object schema (settings or credentials). */
export function describeSchemaFields(schema: z.ZodType, options: { secret: boolean }): ProviderFieldDescriptor[] {
  const root = toJsonSchema(schema);
  const required = new Set(root.required ?? []);
  return Object.entries(root.properties ?? {}).map(([name, raw]) => {
    const node = unwrapNullable(raw);
    const type = fieldType(node);
    const descriptor: ProviderFieldDescriptor = {
      name,
      label: humanizeFieldName(name),
      type,
      required: required.has(name),
      secret: options.secret,
    };
    const description = node.description ?? raw.description;
    if (description) descriptor.description = description;
    if (type === 'enum') descriptor.options = (node.enum ?? []).map(String);
    if (node.default !== undefined && !options.secret) descriptor.default = node.default;
    if (node.pattern) descriptor.pattern = node.pattern;
    const min = node.minimum ?? (type === 'json' ? undefined : node.minLength);
    const max = node.maximum ?? (type === 'json' ? undefined : node.maxLength);
    if (min !== undefined) descriptor.min = min;
    if (max !== undefined) descriptor.max = max;
    return descriptor;
  });
}

/** Names of the fields an object schema declares (used to reject unknown credential keys). */
export function declaredFieldNames(schema: z.ZodType): string[] {
  return Object.keys(toJsonSchema(schema).properties ?? {});
}
