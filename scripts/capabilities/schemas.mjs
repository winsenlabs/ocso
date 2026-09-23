/**
 * Route inputs as JSON Schema for the capability catalog: the zod schemas of
 * @Param / @Query / @Body through `z.toJSONSchema(…, { io: 'input' })`, with
 * `approval` removed from bodies (the confirmation card adds it).
 */

export const PARAMTYPE = { REQUEST: 0, RESPONSE: 1, NEXT: 2, BODY: 3, QUERY: 4, PARAM: 5, HEADERS: 6, SESSION: 7, FILE: 8, FILES: 9, RAW_BODY: 12 };

/** Field names that carry credentials. Such fields never reach the model: optional ones are cut from the input, required ones exclude the route. */
export const SECRET_FIELD = /(^|_|[a-z])(secrets?|password|passphrase|api_?key|token|credentials?|private_?key)$/i;
export const isSecretField = (name, schema) => SECRET_FIELD.test(name) && !['boolean', 'number', 'integer'].includes(schema?.type);

export function makeJsonSchema(z) {
  const tidy = (node) => {
    if (Array.isArray(node)) return node.map(tidy);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$schema') continue;
      // `format: uuid|email|date-time` says it; the regex zod adds alongside is noise for a model.
      if (k === 'pattern' && typeof node.format === 'string') continue;
      out[k] = tidy(v);
    }
    return out;
  };
  return (schema) => tidy(z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' }));
}

function isOptionalSchema(schema) {
  try {
    return schema.safeParse(undefined).success;
  } catch {
    return false;
  }
}

/** Object schema from named pieces (`@Param('id', { schema })`, `@Query('from', …)`). */
function objectOf(pieces) {
  const properties = {};
  const required = [];
  for (const [name, { schema, optional }] of pieces) {
    properties[name] = schema;
    if (!optional) required.push(name);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

/** Unwrap `.optional()` bodies (`WithApproval.optional()`) to the object, then drop `approval` (the card adds it). */
function bodySchema(toJson, schema) {
  let s = schema;
  while (s && typeof s.unwrap === 'function' && (s.def?.type === 'optional' || s._zod?.def?.type === 'optional')) s = s.unwrap();
  const json = toJson(s);
  const hasApproval = Boolean(json?.properties && 'approval' in json.properties);
  if (json?.properties) {
    delete json.properties.approval;
    if (Array.isArray(json.required)) {
      json.required = json.required.filter((k) => k !== 'approval');
      if (!json.required.length) delete json.required;
    }
  }
  const empty = json?.type === 'object' && json.properties && Object.keys(json.properties).length === 0;
  return { json: empty ? undefined : json, hasApproval };
}

export function inputOf(route, toJson) {
  const params = [];
  const query = [];
  let queryWhole;
  let body;
  let governedBody = false;
  const bodyFields = [];
  for (const a of route.args) {
    if (a.custom) continue;
    if (a.type === PARAMTYPE.PARAM) {
      if (typeof a.data === 'string') params.push([a.data, { schema: a.schema ? toJson(a.schema) : { type: 'string' }, optional: false }]);
    } else if (a.type === PARAMTYPE.QUERY) {
      if (typeof a.data === 'string') query.push([a.data, { schema: a.schema ? toJson(a.schema) : { type: 'string' }, optional: a.schema ? isOptionalSchema(a.schema) : true }]);
      else if (a.schema) queryWhole = toJson(a.schema);
    } else if (a.type === PARAMTYPE.BODY) {
      if (typeof a.data === 'string') bodyFields.push([a.data, { schema: a.schema ? toJson(a.schema) : {}, optional: a.schema ? isOptionalSchema(a.schema) : true }]);
      else if (a.schema) {
        const b = bodySchema(toJson, a.schema);
        body = b.json;
        governedBody = b.hasApproval;
      }
    }
  }
  // Path params the handler does not inject still have to be supplied.
  for (const m of route.path.matchAll(/:(\w+)/g)) {
    if (!params.some(([n]) => n === m[1])) params.push([m[1], { schema: { type: 'string' }, optional: false }]);
  }
  params.sort(([a], [b]) => route.path.indexOf(`:${a}`) - route.path.indexOf(`:${b}`));
  if (bodyFields.length) body = objectOf(bodyFields);
  const input = {};
  if (params.length) input.params = objectOf(params);
  if (queryWhole) input.query = queryWhole;
  else if (query.length) input.query = objectOf(query);
  if (body) input.body = body;
  return { input, governedBody };
}

/** Every `[name, schema]` property below the top level of a JSON Schema. */
export function nestedProperties(schema, depth = 0, out = []) {
  if (Array.isArray(schema)) schema.forEach((s) => nestedProperties(s, depth, out));
  else if (schema && typeof schema === 'object') {
    for (const [k, v] of Object.entries(schema)) {
      if (k === 'properties' && v && typeof v === 'object') {
        for (const [name, sub] of Object.entries(v)) {
          if (depth > 0) out.push([name, sub]);
          nestedProperties(sub, depth + 1, out);
        }
      } else if (v && typeof v === 'object') nestedProperties(v, depth, out);
    }
  }
  return out;
}
