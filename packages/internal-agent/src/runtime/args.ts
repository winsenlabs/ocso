import { createAjvValidator } from '@ocso/tools';
import { validation } from '@ocso/domain';
import { fillPath, isSafePathValue, type Capability, type JsonSchema } from '../catalog/index.js';

type In = 'path' | 'query' | 'body';

/** Keys the model may never send: the card adds the approval; bootstrap is UI-only (owner decision). */
const RESERVED = new Set(['approval', 'bootstrap']);

const props = (schema: JsonSchema | undefined): Record<string, JsonSchema> => ((schema?.['properties'] as Record<string, JsonSchema> | undefined) ?? {});
const required = (schema: JsonSchema | undefined): string[] => ((schema?.['required'] as string[] | undefined) ?? []);

/** Schema noise the model does not need. */
function compact(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(compact);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(
    Object.entries(schema as Record<string, unknown>)
      .filter(([k]) => k !== '$schema' && k !== 'additionalProperties' && k !== 'propertyNames')
      .map(([k, v]) => [k, compact(v)]),
  );
}

/**
 * The tool's input as one object for the model (BUILD.md): path, query and body fields merged, each marked with
 * `in`. No catalog route repeats a name across the three (capabilities.test pins the catalog).
 */
export function compactInput(capability: Capability): JsonSchema {
  const properties: Record<string, unknown> = {};
  const req: string[] = [];
  const parts: Array<[In, JsonSchema | undefined]> = [
    ['path', capability.input.params],
    ['query', capability.input.query],
    ['body', capability.input.body],
  ];
  for (const [where, schema] of parts) {
    for (const [key, value] of Object.entries(props(schema))) properties[key] = { ...(compact(value) as object), in: where };
    req.push(...required(schema));
  }
  return { type: 'object', properties, ...(req.length ? { required: [...new Set(req)] } : {}) };
}

export interface SplitArgs {
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  body: Record<string, unknown> | undefined;
}

const validate = createAjvValidator();

/**
 * The model's flat arguments → the route's path, query and body, validated against the route's own schemas
 * (generated from its zod schemas, so they agree with what the route will check). Throws a validation error
 * the model can correct. The approval field and credential fields are refused: the card adds the first, and
 * credentials are typed into the UI, never into chat.
 */
export function splitArgs(capability: Capability, raw: unknown): SplitArgs {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) throw validation('invalid_tool_arguments', 'args must be an object');
  const args = (raw ?? {}) as Record<string, unknown>;
  const reserved = Object.keys(args).filter((k) => RESERVED.has(k));
  if (reserved.length) throw validation('invalid_tool_arguments', `${reserved.join(', ')} is added by the confirmation card; leave it out`);
  const secret = Object.keys(args).filter((k) => capability.secretInputs?.includes(k));
  if (secret.length) throw validation('secret_input', `${secret.join(', ')} must be entered in the OCSO UI, never in chat`);

  const paramKeys = new Set(Object.keys(props(capability.input.params)));
  const queryKeys = new Set(Object.keys(props(capability.input.query)));
  const bodyKeys = new Set(Object.keys(props(capability.input.body)));
  const params: Record<string, unknown> = {};
  const query: Record<string, unknown> = {};
  const body: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    if (paramKeys.has(key)) params[key] = value;
    else if (queryKeys.has(key)) query[key] = value;
    else if (bodyKeys.has(key)) body[key] = value;
    else unknown.push(key);
  }
  if (unknown.length) throw validation('invalid_tool_arguments', `unknown argument${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} for ${capability.name}`);

  const problems: string[] = [];
  const unsafe = Object.entries(params).filter(([, v]) => !isSafePathValue(v)).map(([k]) => k);
  if (unsafe.length) problems.push(`path ${unsafe.join(', ')} must be an id, not '.', '..' or a value with a slash`);
  if (capability.input.params) {
    const r = validate(capability.input.params, params);
    if (!r.valid) problems.push(...r.errors.map((e) => `path ${e}`));
  }
  const hasBody = capability.input.body !== undefined;
  if (hasBody) {
    const r = validate(capability.input.body!, body);
    if (!r.valid) problems.push(...r.errors.map((e) => `body ${e}`));
  }
  const missingQuery = required(capability.input.query).filter((k) => query[k] === undefined);
  if (missingQuery.length) problems.push(`query must have ${missingQuery.join(', ')}`);
  if (problems.length) throw validation('invalid_tool_arguments', problems.slice(0, 8).join('; '));
  return { params, query, body: hasBody ? body : undefined };
}

/** The route's concrete path for these arguments. */
export function routePath(capability: Capability, params: Record<string, unknown>): string {
  const path = fillPath(capability.path, params);
  if (!path) throw validation('invalid_tool_arguments', `missing or invalid path parameters for ${capability.name} (each must be an id, never '.', '..' or a value with a slash)`);
  return path;
}

/** Keys that name a credential anywhere in a tool call's arguments (checked case-insensitively, at any depth). */
const SECRET_KEY = /^(password|passphrase|secrets?|credentials?|api[_-]?key|access[_-]?token|refresh[_-]?token|token|client[_-]?secret|private[_-]?key|signing[_-]?key|bearer)$/i;
export const REMOVED_SECRET = '[removed: credentials are entered in the OCSO UI, never kept in the thread]';

function withoutSecrets(value: unknown, extra: ReadonlySet<string>, depth = 0): unknown {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => withoutSecrets(v, extra, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEY.test(k) || extra.has(k) ? REMOVED_SECRET : withoutSecrets(v, extra, depth + 1)]));
}

/**
 * A tool call's input as the thread keeps it (PM/research/12 §9: credentials never enter the thread). The model
 * may still try to pass one: splitArgs refuses it, and it is removed here before the call is stored, whether the
 * call succeeded or not. `secretInputs`: the capability's own credential fields.
 */
export function storedToolInput(input: unknown, secretInputs: readonly string[] = []): unknown {
  return withoutSecrets(input, new Set(secretInputs));
}
