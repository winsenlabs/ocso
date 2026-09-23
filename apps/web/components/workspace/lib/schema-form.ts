/**
 * JSON-Schema → form model for the composer's "Tool action" mode (design/01).
 * Covers the flat object schemas MCP tools publish: strings (enum, date,
 * pattern), numbers/integers, booleans and string arrays; anything nested is
 * edited as JSON. The API validates the final arguments against the full
 * schema (packages/tools ajv) — this only makes the form usable.
 */

export type FieldKind = 'text' | 'enum' | 'date' | 'number' | 'integer' | 'boolean' | 'list' | 'json';

export interface FormField {
  name: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  description: string | null;
  options: string[];
  pattern: string | null;
  minLength: number | null;
  maxLength: number | null;
  minimum: number | null;
  maximum: number | null;
}

interface Node {
  type?: string | string[];
  enum?: unknown[];
  format?: string;
  description?: string;
  title?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  items?: Node;
  properties?: Record<string, Node>;
  required?: string[];
}

const typeOf = (n: Node): string | undefined => (Array.isArray(n.type) ? n.type.find((t) => t !== 'null') : n.type);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function kindOf(n: Node): FieldKind {
  if (Array.isArray(n.enum) && n.enum.length > 0 && n.enum.every((v) => typeof v === 'string')) return 'enum';
  switch (typeOf(n)) {
    case 'string':
      return n.format === 'date' ? 'date' : 'text';
    case 'number':
      return 'number';
    case 'integer':
      return 'integer';
    case 'boolean':
      return 'boolean';
    case 'array':
      return n.items && typeOf(n.items) === 'string' && !n.items.enum ? 'list' : 'json';
    default:
      return 'json';
  }
}

/** "amountMinor" / "txn_id" → "Amount minor" / "Txn id". */
export function humanizeName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function schemaFields(schema: unknown): FormField[] {
  const root = (typeof schema === 'object' && schema !== null ? schema : {}) as Node;
  const required = new Set(root.required ?? []);
  return Object.entries(root.properties ?? {}).map(([name, node]) => ({
    name,
    label: node.title ?? humanizeName(name),
    kind: kindOf(node),
    required: required.has(name),
    description: node.description ?? null,
    options: Array.isArray(node.enum) ? node.enum.map(String) : [],
    pattern: typeof node.pattern === 'string' ? node.pattern : null,
    minLength: num(node.minLength),
    maxLength: num(node.maxLength),
    minimum: num(node.minimum),
    maximum: num(node.maximum),
  }));
}

export type FormValues = Record<string, string | boolean>;

export interface BuiltArgs {
  args: Record<string, unknown>;
  errors: Record<string, string>;
}

/** Form values → tool arguments, with per-field messages for what is clearly wrong. */
export function buildArgs(fields: readonly FormField[], values: FormValues): BuiltArgs {
  const args: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const raw = values[f.name];
    if (f.kind === 'boolean') {
      if (raw === true || f.required) args[f.name] = raw === true;
      continue;
    }
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) {
      if (f.required) errors[f.name] = 'Required';
      continue;
    }
    const result = coerce(f, text);
    if (result.ok) args[f.name] = result.value;
    else errors[f.name] = result.error;
  }
  return { args, errors };
}

type Coerced = { ok: true; value: unknown } | { ok: false; error: string };
const ok = (value: unknown): Coerced => ({ ok: true, value });
const bad = (error: string): Coerced => ({ ok: false, error });

function coerce(f: FormField, text: string): Coerced {
  switch (f.kind) {
    case 'number':
    case 'integer': {
      const n = Number(text.replace(/,/g, ''));
      if (!Number.isFinite(n)) return bad('Enter a number');
      if (f.kind === 'integer' && !Number.isInteger(n)) return bad('Enter a whole number');
      if (f.minimum !== null && n < f.minimum) return bad(`At least ${f.minimum}`);
      if (f.maximum !== null && n > f.maximum) return bad(`At most ${f.maximum}`);
      return ok(n);
    }
    case 'list':
      return ok(text.split(',').map((s) => s.trim()).filter(Boolean));
    case 'json':
      try {
        return ok(JSON.parse(text) as unknown);
      } catch {
        return bad('Enter valid JSON');
      }
    default: {
      if (f.minLength !== null && text.length < f.minLength) return bad(`At least ${f.minLength} characters`);
      if (f.maxLength !== null && text.length > f.maxLength) return bad(`At most ${f.maxLength} characters`);
      if (f.pattern && !safeTest(f.pattern, text)) return bad('Not in the expected format');
      if (f.kind === 'enum' && f.options.length && !f.options.includes(text)) return bad('Choose one of the options');
      return ok(text);
    }
  }
}

function safeTest(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, 'u').test(text);
  } catch {
    return true;
  }
}
