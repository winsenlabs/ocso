/**
 * Alert-rule params form model from the evaluator's JSON Schema
 * (GET /v1/alert-rules/conditions → params). Covers the flat shapes the
 * built-in evaluators publish: numbers/integers, string enums, strings,
 * booleans, string lists and enum lists; anything else is edited as JSON.
 * Blank optional fields are omitted so the API applies its defaults; the API
 * validates the final params with the evaluator's own schema.
 */

export type ParamKind = 'number' | 'integer' | 'enum' | 'text' | 'boolean' | 'list' | 'enum-list' | 'json';

export interface ParamField {
  name: string;
  label: string;
  kind: ParamKind;
  options: string[];
  /** Default as the form shows it ('' when none). */
  defaultText: string;
  description: string | null;
  min: number | null;
  max: number | null;
}

interface Node {
  type?: string | string[];
  enum?: unknown[];
  default?: unknown;
  description?: string;
  title?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  items?: Node;
  properties?: Record<string, Node>;
}

const typeOf = (n: Node | undefined) => (Array.isArray(n?.type) ? n.type.find((t) => t !== 'null') : n?.type);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function kindOf(n: Node): ParamKind {
  if (strings(n.enum) && n.enum.length) return 'enum';
  switch (typeOf(n)) {
    case 'number':
      return 'number';
    case 'integer':
      return 'integer';
    case 'boolean':
      return 'boolean';
    case 'string':
      return 'text';
    case 'array':
      if (n.items && strings(n.items.enum) && n.items.enum.length) return 'enum-list';
      return typeOf(n.items) === 'string' ? 'list' : 'json';
    default:
      return 'json';
  }
}

/** "thresholdPercent" → "Threshold percent". */
export function paramLabel(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function toText(kind: ParamKind, value: unknown): string {
  if (value === undefined || value === null) return '';
  if (kind === 'list' || kind === 'enum-list') return Array.isArray(value) ? value.join(', ') : '';
  if (kind === 'json') return JSON.stringify(value);
  if (kind === 'boolean') return value === true ? 'true' : 'false';
  return String(value);
}

export function paramFields(schema: unknown): ParamField[] {
  const root = (typeof schema === 'object' && schema !== null ? schema : {}) as Node;
  return Object.entries(root.properties ?? {}).map(([name, node]) => {
    const kind = kindOf(node);
    return {
      name,
      label: node.title ?? paramLabel(name),
      kind,
      options: kind === 'enum' && strings(node.enum) ? node.enum : kind === 'enum-list' && strings(node.items?.enum) ? node.items.enum : [],
      defaultText: toText(kind, node.default),
      description: node.description ?? null,
      min: node.minimum ?? node.exclusiveMinimum ?? null,
      max: node.maximum ?? node.exclusiveMaximum ?? null,
    };
  });
}

/** Form strings for a rule: its stored params, else each field's default. */
export function initialParamText(fields: ParamField[], params: Record<string, unknown> | null): Record<string, string> {
  return Object.fromEntries(fields.map((f) => [f.name, params && f.name in params ? toText(f.kind, params[f.name]) : f.defaultText]));
}

export type BuiltParams = { ok: true; params: Record<string, unknown> } | { ok: false; errors: Record<string, string> };

/** Form strings → params; only type conversion here, bounds are the API's. */
export function buildParams(fields: ParamField[], text: Record<string, string>): BuiltParams {
  const params: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const raw = (text[f.name] ?? '').trim();
    if (raw === '') continue;
    switch (f.kind) {
      case 'number':
      case 'integer': {
        const n = Number(raw);
        if (!Number.isFinite(n) || (f.kind === 'integer' && !Number.isInteger(n))) errors[f.name] = f.kind === 'integer' ? 'Enter a whole number' : 'Enter a number';
        else params[f.name] = n;
        break;
      }
      case 'boolean':
        params[f.name] = raw === 'true';
        break;
      case 'list':
      case 'enum-list':
        params[f.name] = raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case 'json':
        try {
          params[f.name] = JSON.parse(raw) as unknown;
        } catch {
          errors[f.name] = 'Enter valid JSON';
        }
        break;
      default:
        params[f.name] = raw;
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, params };
}
