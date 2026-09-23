import { buildSettings, initialSettingsValues, settingsGroups, type SettingsGroup } from '../connections/channels/settings-form';
import type { FormValues } from '../workspace/lib/schema-form';

/**
 * Notification destination form, rendered from the delivery adapter's JSON
 * Schema (GET /v1/notification-destinations/kinds) with the channel settings
 * renderer. Pure and client-safe; nothing here knows a destination kind.
 *
 * A config with variants is a `oneOf` whose branches pin one property with
 * `const` (email `transport`): the form shows a picker for that property and
 * the fields of the chosen branch. Secrets are write-only and stored in the
 * SecretStore; `secret.when` limits the secret field to matching configs.
 */

export interface ConfigVariant {
  /** The pinned value (`smtp`); '' for a schema without variants. */
  value: string;
  label: string;
  group: SettingsGroup;
}

export interface ConfigForm {
  /** The property that selects a variant, or null for a plain object schema. */
  variantKey: string | null;
  variantLabel: string;
  variants: ConfigVariant[];
}

interface Node {
  title?: string;
  const?: unknown;
  oneOf?: Node[];
  anyOf?: Node[];
  properties?: Record<string, Node>;
  required?: string[];
}

const asNode = (v: unknown): Node => (typeof v === 'object' && v !== null ? (v as Node) : {});

/** Property every branch pins with a string `const`, if any. */
function discriminator(branches: Node[]): string | null {
  const first = branches[0]?.properties ?? {};
  return Object.keys(first).find((key) => branches.every((b) => typeof b.properties?.[key]?.const === 'string')) ?? null;
}

export function configForm(schema: unknown): ConfigForm {
  const root = asNode(schema);
  const branches = (root.oneOf ?? root.anyOf ?? []).map(asNode);
  const key = branches.length ? discriminator(branches) : null;
  if (!key) return { variantKey: null, variantLabel: '', variants: [{ value: '', label: '', group: settingsGroups(root) }] };
  return {
    variantKey: key,
    variantLabel: branches[0]?.properties?.[key]?.title ?? key,
    variants: branches.map((b) => {
      const value = String(b.properties?.[key]?.const);
      const { [key]: _pinned, ...properties } = b.properties ?? {};
      return { value, label: b.title ?? value, group: settingsGroups({ ...b, properties, required: (b.required ?? []).filter((r) => r !== key) }) };
    }),
  };
}

/** The variant the values select (first variant when unset). */
export function activeVariant(form: ConfigForm, values: FormValues): ConfigVariant {
  const chosen = form.variantKey ? values[form.variantKey] : '';
  return form.variants.find((v) => v.value === chosen) ?? form.variants[0]!;
}

/** Form values for a stored config (edit) or a new destination; every variant's fields are prefilled so switching keeps defaults. */
export function initialConfigValues(form: ConfigForm, config: Record<string, unknown> | null): FormValues {
  const values: FormValues = {};
  for (const v of [...form.variants].reverse()) Object.assign(values, initialSettingsValues(v.group, config));
  if (form.variantKey) {
    const stored = config?.[form.variantKey];
    values[form.variantKey] = form.variants.some((v) => v.value === stored) ? String(stored) : (form.variants[0]?.value ?? '');
  }
  return values;
}

/** Form values → config for the chosen variant (blank fields left out so the adapter's defaults apply). */
export function buildDestinationConfig(form: ConfigForm, values: FormValues): { config: Record<string, unknown>; errors: Record<string, string> } {
  const variant = activeVariant(form, values);
  const { settings, errors } = buildSettings(variant.group, values);
  return { config: form.variantKey ? { [form.variantKey]: variant.value, ...settings } : settings, errors };
}

/** Whether the adapter's secret applies to the config being edited (`secret.when`). */
export function secretApplies(secret: { when: Record<string, string> | null } | null, values: FormValues): boolean {
  if (!secret) return false;
  return Object.entries(secret.when ?? {}).every(([field, value]) => values[field] === value);
}

const EVENT_WORDS: Record<string, string> = { OPENED: 'opened', ACKNOWLEDGED: 'acknowledged', RESOLVED: 'resolved', REMINDER: 'reminders' };

/** ["OPENED", "RESOLVED", "REMINDER"] → "opened, resolved and reminders". */
export function receivesText(events: readonly string[]): string {
  const words = events.map((e) => EVENT_WORDS[e] ?? e.toLowerCase());
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : (words[0] ?? 'nothing');
}
