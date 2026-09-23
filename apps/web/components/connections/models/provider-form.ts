import type { FieldDescriptor } from '../../../lib/api/models';

/**
 * Provider settings/credentials forms are generated from the adapter's own
 * field descriptors (GET /v1/model-providers/kinds), so no provider needs
 * bespoke UI code. Values are strings while editing (booleans for checkboxes).
 */

export type FieldValue = string | boolean;

/** A boolean without a default has three states: provider decides / on / off. */
export const isTriState = (d: FieldDescriptor): boolean => d.type === 'boolean' && d.default === undefined;

export function initialFieldValues(descriptors: readonly FieldDescriptor[], settings: Readonly<Record<string, unknown>> | null): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};
  for (const d of descriptors) {
    const current = settings && d.name in settings ? settings[d.name] : d.default;
    if (d.type === 'boolean') values[d.name] = isTriState(d) ? (current === undefined ? '' : String(current === true)) : current === true;
    else if (d.type === 'json') values[d.name] = current === undefined ? '' : JSON.stringify(current, null, 2);
    else values[d.name] = current === undefined || current === null ? '' : String(current);
  }
  return values;
}

function numberValue(d: FieldDescriptor, raw: string): number | string {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 'Enter a number';
  if (d.type === 'integer' && !Number.isInteger(value)) return 'Enter a whole number';
  if (d.min !== undefined && value < d.min) return `At least ${d.min}`;
  if (d.max !== undefined && value > d.max) return `At most ${d.max}`;
  return value;
}

/** Form values → the provider's `settings` object; blank optional fields are left out (adapter defaults apply). */
export function settingsFromValues(
  descriptors: readonly FieldDescriptor[],
  values: Readonly<Record<string, FieldValue>>,
): { settings: Record<string, unknown>; errors: Record<string, string> } {
  const settings: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const d of descriptors) {
    const raw = values[d.name];
    if (d.type === 'boolean') {
      if (typeof raw === 'boolean') settings[d.name] = raw;
      else if (raw === 'true' || raw === 'false') settings[d.name] = raw === 'true';
      continue;
    }
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text === '') {
      if (d.required) errors[d.name] = 'Required';
      continue;
    }
    if (d.type === 'integer' || d.type === 'number') {
      const n = numberValue(d, text);
      if (typeof n === 'string') errors[d.name] = n;
      else settings[d.name] = n;
    } else if (d.type === 'json') {
      try {
        settings[d.name] = JSON.parse(text);
      } catch {
        errors[d.name] = 'Enter valid JSON';
      }
    } else {
      if (d.options && !d.options.includes(text)) errors[d.name] = `One of ${d.options.join(', ')}`;
      else settings[d.name] = text;
    }
  }
  return { settings, errors };
}

/**
 * Write-only credentials. On create every non-blank value is sent; on edit a
 * value rotates the credential, `null` removes it and blank keeps it.
 */
export function credentialsFromValues(
  descriptors: readonly FieldDescriptor[],
  values: Readonly<Record<string, string>>,
  options: { editing: boolean; removed: ReadonlySet<string>; stored: ReadonlySet<string> },
): { credentials: Record<string, string | null>; errors: Record<string, string> } {
  const credentials: Record<string, string | null> = {};
  const errors: Record<string, string> = {};
  for (const d of descriptors) {
    const value = values[d.name] ?? '';
    if (value.trim() !== '') credentials[d.name] = value;
    else if (options.editing && options.removed.has(d.name)) {
      if (d.required) errors[d.name] = 'Required — enter a replacement instead of removing it';
      else credentials[d.name] = null;
    } else if (d.required && !(options.editing && options.stored.has(d.name))) errors[d.name] = 'Required';
  }
  return { credentials, errors };
}
