/**
 * Customer edit form parsing (pure; server action + unit tests). Mirrors
 * CustomerPatch in packages/application/src/customers/customers.ts.
 */

export interface CustomerFormData {
  displayName: string | null;
  language: string | null;
  externalRef: string | null;
  attributes: Record<string, unknown>;
  accountOwnerUserId: string | null;
}

type Result = { ok: true; data: CustomerFormData } | { ok: false; fieldErrors: Record<string, string> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Attributes are edited as a JSON object; blank means "no attributes". */
export function parseAttributes(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const t = text.trim();
  if (!t) return { ok: true, value: {} };
  let value: unknown;
  try {
    value = JSON.parse(t);
  } catch {
    return { ok: false, message: 'Not valid JSON — use {"key": "value"}' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, message: 'Attributes must be a JSON object, e.g. {"segment": "priority"}' };
  return { ok: true, value: value as Record<string, unknown> };
}

export function parseCustomerForm(f: Record<string, string>): Result {
  const errors: Record<string, string> = {};
  const text = (key: string, max: number): string | null => {
    const v = (f[key] ?? '').trim();
    if (v.length > max) errors[key] = `At most ${max} characters`;
    return v || null;
  };
  const displayName = text('displayName', 200);
  const language = text('language', 20);
  const externalRef = text('externalRef', 200);
  const owner = (f['accountOwnerUserId'] ?? '').trim();
  if (owner && !UUID.test(owner)) errors['accountOwnerUserId'] = 'Choose from the list';
  const attrs = parseAttributes(f['attributes'] ?? '');
  if (!attrs.ok) errors['attributes'] = attrs.message;
  if (Object.keys(errors).length || !attrs.ok) return { ok: false, fieldErrors: errors };
  return { ok: true, data: { displayName, language, externalRef, attributes: attrs.value, accountOwnerUserId: owner || null } };
}

/** Attribute values as the detail view prints them (strings verbatim, others as compact JSON). */
export function attributeText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '—';
  return JSON.stringify(value);
}
