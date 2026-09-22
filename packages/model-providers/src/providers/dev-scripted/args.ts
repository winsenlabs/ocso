/**
 * Plausible tool arguments derived from a JSON Schema and the customer's
 * text (dev-only). Deterministic: the same schema + text give the same args.
 */

interface SchemaNode {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  format?: string;
}

const NUMBER = /(?:₹|rs\.?|inr|\$|usd)?\s*(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)/i;
const DIGITS = /\b\d{4,}\b/;
const ID_TOKEN = /\b(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{4,}\b/;

export function firstNumber(text: string): number | undefined {
  const m = NUMBER.exec(text);
  if (!m?.[1]) return undefined;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

const typeOf = (node: SchemaNode): string | undefined => (Array.isArray(node.type) ? node.type.find((t) => t !== 'null') : node.type);
const snippet = (text: string) => text.trim().replace(/\s+/g, ' ').slice(0, 200);

function numberFor(name: string, text: string, integer: boolean): number {
  const lower = name.toLowerCase();
  let value: number;
  if (/amount|value|sum|price|total/.test(lower)) value = firstNumber(text) ?? 100;
  else if (/limit|count|max|size|days|page|n$/.test(lower)) value = 5;
  else value = firstNumber(text) ?? 1;
  return integer ? Math.round(value) : value;
}

function stringFor(name: string, node: SchemaNode, text: string): string {
  const lower = name.toLowerCase();
  if (node.format === 'date') return new Date().toISOString().slice(0, 10);
  if (node.format === 'date-time') return new Date().toISOString();
  if (/reason|summary|note|message|description|comment|query|issue|text/.test(lower)) return snippet(text) || 'Customer request';
  if (/currency/.test(lower)) return 'INR';
  if (/account|card|last4|number/.test(lower)) return DIGITS.exec(text)?.[0] ?? 'primary';
  if (/id$/.test(lower)) return ID_TOKEN.exec(text.toUpperCase())?.[0] ?? 'latest';
  return snippet(text) || name;
}

function valueFor(name: string, node: SchemaNode, text: string): unknown {
  if (node.enum && node.enum.length > 0) {
    const mentioned = node.enum.find((v) => typeof v === 'string' && text.toLowerCase().includes(v.toLowerCase()));
    return mentioned ?? node.enum[0];
  }
  switch (typeOf(node)) {
    case 'number':
      return numberFor(name, text, false);
    case 'integer':
      return numberFor(name, text, true);
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return plausibleArgs(node, text);
    default:
      return stringFor(name, node, text);
  }
}

/** Required properties always; optional amount/reason-like ones when the text supports them. */
export function plausibleArgs(schema: unknown, text: string): Record<string, unknown> {
  const node = (typeof schema === 'object' && schema !== null ? schema : {}) as SchemaNode;
  const required = new Set(node.required ?? []);
  const args: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(node.properties ?? {})) {
    const lower = name.toLowerCase();
    const optionalButInferable =
      (/amount/.test(lower) && firstNumber(text) !== undefined) || /reason|summary/.test(lower);
    if (required.has(name) || optionalButInferable) args[name] = valueFor(name, prop, text);
  }
  return args;
}
