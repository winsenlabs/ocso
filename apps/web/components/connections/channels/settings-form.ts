import { buildArgs, humanizeName, schemaFields, type FormField, type FormValues } from '../../workspace/lib/schema-form';

/**
 * Channel settings form from the adapter's JSON Schema (GET /v1/channels/kinds,
 * input shape). Leaf fields reuse the workspace's schema-form helper; this adds
 * nested objects (web chat `branding`) as field groups, string lists one per
 * line (`allowedOrigins`), and defaults: a blank field is left out so the
 * adapter's default applies. Values are keyed by dotted path.
 */

export interface SettingsField extends FormField {
  path: string;
  /** JSON Schema default, shown as a placeholder / "Default (…)" option. */
  defaultValue: unknown;
}

export interface SettingsGroup {
  path: string;
  label: string;
  fields: SettingsField[];
  groups: SettingsGroup[];
}

interface Node {
  type?: string | string[];
  properties?: Record<string, Node>;
  default?: unknown;
  title?: string;
}

const isObjectNode = (n: Node | undefined): n is Node & { properties: Record<string, Node> } =>
  !!n && (n.type === 'object' || (Array.isArray(n.type) && n.type.includes('object'))) && typeof n.properties === 'object' && n.properties !== null;

const join = (prefix: string, name: string) => (prefix ? `${prefix}.${name}` : name);

/** The schema as nested groups of fields (root group has path ''). */
export function settingsGroups(schema: unknown, path = '', label = ''): SettingsGroup {
  const root = (typeof schema === 'object' && schema !== null ? schema : {}) as Node;
  const props = root.properties ?? {};
  const group: SettingsGroup = { path, label, fields: [], groups: [] };
  for (const field of schemaFields(root)) {
    const node = props[field.name];
    if (isObjectNode(node)) group.groups.push(settingsGroups(node, join(path, field.name), node.title ?? humanizeName(field.name)));
    else group.fields.push({ ...field, path: join(path, field.name), defaultValue: node?.default });
  }
  return group;
}

function valueAt(settings: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((obj, key) => (obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined), settings);
}

/** Form values for stored settings (edit) or an empty form (blank = default applies). */
export function initialSettingsValues(group: SettingsGroup, settings: Record<string, unknown> | null): FormValues {
  const values: FormValues = {};
  const walk = (g: SettingsGroup) => {
    for (const f of g.fields) {
      const stored = settings ? valueAt(settings, f.path) : undefined;
      if (f.kind === 'boolean') values[f.path] = stored === undefined ? f.defaultValue === true : stored === true;
      else if (stored === undefined || stored === null) values[f.path] = '';
      else if (f.kind === 'list' && Array.isArray(stored)) values[f.path] = stored.map(String).join('\n');
      else if (f.kind === 'json') values[f.path] = JSON.stringify(stored, null, 2);
      else values[f.path] = String(stored);
    }
    g.groups.forEach(walk);
  };
  walk(group);
  return values;
}

/** Form values → the settings object (PATCH replaces it whole), with messages keyed by path. */
export function buildSettings(group: SettingsGroup, values: FormValues): { settings: Record<string, unknown>; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const build = (g: SettingsGroup): Record<string, unknown> => {
    const local: FormValues = {};
    const leaves = g.fields.filter((f) => f.kind !== 'boolean');
    for (const f of leaves) {
      const raw = values[f.path];
      // Lists are typed one per line; the shared helper splits on commas.
      local[f.name] = f.kind === 'list' && typeof raw === 'string' ? raw.split('\n').join(',') : (raw ?? '');
    }
    const built = buildArgs(leaves, local);
    for (const [name, message] of Object.entries(built.errors)) errors[join(g.path, name)] = message;
    const out: Record<string, unknown> = { ...built.args };
    // Booleans are always explicit so unchecking a default-on option sticks.
    for (const f of g.fields.filter((x) => x.kind === 'boolean')) out[f.name] = values[f.path] === true;
    for (const child of g.groups) {
      const nested = build(child);
      if (Object.keys(nested).length) out[child.path.split('.').pop()!] = nested;
    }
    return out;
  };
  return { settings: build(group), errors };
}

/**
 * Channel config problems come back as one message, `settings.<path>: … ;
 * secrets.<key>: …` (or `name: …` for request validation). Split them so
 * each shows under its field; anything unmatched stays in the banner.
 */
export function splitProblems(message: string): { settings: Record<string, string>; secrets: Record<string, string>; fields: Record<string, string>; other: string[] } {
  const out = { settings: {} as Record<string, string>, secrets: {} as Record<string, string>, fields: {} as Record<string, string>, other: [] as string[] };
  for (const part of message.split(/;\s+/)) {
    const m = /^([A-Za-z0-9_.]+):\s+(.+)$/.exec(part.trim());
    if (!m) {
      if (part.trim()) out.other.push(part.trim());
      continue;
    }
    const [, path = '', text = ''] = m;
    if (path.startsWith('settings.')) out.settings[path.slice('settings.'.length)] ??= text;
    else if (path.startsWith('secrets.')) out.secrets[path.slice('secrets.'.length)] ??= text;
    else if (['name', 'status', 'defaultAgentId'].includes(path)) out.fields[path] ??= text;
    else out.other.push(part.trim());
  }
  return out;
}

/** 32 random bytes as base64url (43 chars, no whitespace) — long enough for every secret the adapters check. */
export function randomSecret(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Where the provider calls OCSO: the webhook path the API derived from the kind's descriptor (null when the kind has none). */
export function inboundWebhookUrl(origin: string, channel: { webhookPath: string | null }): string | null {
  return channel.webhookPath ? `${origin.replace(/\/+$/, '')}${channel.webhookPath}` : null;
}

/** The first identifying setting the kind's descriptor names that holds a value (e.g. the WhatsApp sender), for the channel card. */
export function identitySettingOf(settings: Record<string, unknown>, setting: { label: string; keys: readonly string[] } | null): { k: string; v: string } | null {
  for (const key of setting?.keys ?? []) {
    const value = settings[key];
    if (setting && typeof value === 'string' && value) return { k: setting.label, v: value };
  }
  return null;
}

export function embedSnippet(origin: string, publicKey: string): string {
  return `<script src="${origin.replace(/\/+$/, '')}/ocso-webchat.js" data-key="${publicKey}" async></script>`;
}
