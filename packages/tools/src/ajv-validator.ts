import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { SchemaValidator } from './types.js';

/**
 * JSON Schema validation of tool arguments (docs/08 §6 check 6). Compiled
 * validators are cached by schema object identity; schemas come from approved
 * tool records, never from the model.
 */
export function createAjvValidator(): SchemaValidator {
  const ajv = new Ajv2020({ strict: false, allErrors: true, coerceTypes: false, useDefaults: false });
  (addFormats as unknown as (a: Ajv2020) => void)(ajv);
  const cache = new WeakMap<object, ReturnType<Ajv2020['compile']>>();
  return (schema, value) => {
    let validate = cache.get(schema);
    if (!validate) {
      try {
        validate = ajv.compile(schema);
      } catch {
        return { valid: false, errors: ['tool input schema is invalid'] };
      }
      cache.set(schema, validate);
    }
    if (validate(value)) return { valid: true };
    return {
      valid: false,
      errors: (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`),
    };
  };
}
