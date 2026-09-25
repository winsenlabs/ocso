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
  /**
   * A choice between object shapes (JSON Schema `oneOf`/`anyOf` whose branches share a `const` discriminator,
   * e.g. how user tokens are verified): the admin picks one and fills its fields. Values: the discriminator
   * at `<path>.<discriminator>` ('' = none), the chosen branch's fields at `<path>.<field>`.
   */
  variant?: SettingsVariant | undefined;
}

export interface SettingsVariant {
  discriminator: string;
  required: boolean;
  options: Array<{ value: string; label: string; group: SettingsGroup }>;
}

interface Node {
  type?: string | string[];
  properties?: Record<string, Node>;
  required?: string[];
  default?: unknown;
  title?: string;
  const?: unknown;
  items?: Node;
  oneOf?: Node[];
  anyOf?: Node[];
}

const isObjectNode = (n: Node | undefined): n is Node & { properties: Record<string, Node> } =>
  !!n && (n.type === 'object' || (Array.isArray(n.type) && n.type.includes('object'))) && typeof n.properties === 'object' && n.properties !== null;

const join = (prefix: string, name: string) => (prefix ? `${prefix}.${name}` : name);

/** The shared `const` property of every object branch of a union, if there is one. */
function discriminatorOf(branches: readonly Node[]): string | null {
  if (!branches.length || !branches.every(isObjectNode)) return null;
  const first = branches[0]!.properties ?? {};
  return Object.keys(first).find((key) => branches.every((b) => typeof b.properties?.[key]?.const === 'string')) ?? null;
}

function variantGroup(node: Node, path: string, label: string, required: boolean): SettingsGroup | null {
  const branches = node.oneOf ?? node.anyOf ?? [];
  const discriminator = discriminatorOf(branches);
  if (!discriminator) return null;
  const options = branches.map((branch) => {
    const value = String(branch.properties![discriminator]!.const);
    const { [discriminator]: _omit, ...rest } = branch.properties!;
    const inner = settingsGroups({ ...branch, properties: rest, required: (branch.required ?? []).filter((r) => r !== discriminator) }, path, label);
    return { value, label: branch.title ?? value, group: inner };
  });
  return { path, label, fields: [], groups: [], variant: { discriminator, required, options } };
}

/** The schema as nested groups of fields (root group has path ''). */
export function settingsGroups(schema: unknown, path = '', label = ''): SettingsGroup {
  const root = (typeof schema === 'object' && schema !== null ? schema : {}) as Node;
  const props = root.properties ?? {};
  const required = new Set(root.required ?? []);
  const group: SettingsGroup = { path, label, fields: [], groups: [] };
  for (const field of schemaFields(root)) {
    const node = props[field.name];
    const childPath = join(path, field.name);
    const childLabel = node?.title ?? humanizeName(field.name);
    const variant = node && (node.oneOf || node.anyOf) ? variantGroup(node, childPath, childLabel, required.has(field.name)) : null;
    if (variant) group.groups.push(variant);
    else if (isObjectNode(node)) group.groups.push(settingsGroups(node, childPath, childLabel));
    else {
      // A list of allowed words (string enum items) is typed one per line like any list; the API validates the words.
      const enumList = field.kind === 'json' && node?.type === 'array' && node.items?.type === 'string';
      group.fields.push({ ...field, kind: enumList ? 'list' : field.kind, path: childPath, defaultValue: node?.default });
    }
  }
  return group;
}

/** The branch a variant group currently shows (from the form values), or null for none. */
export function chosenVariant(group: SettingsGroup, values: FormValues): SettingsVariant['options'][number] | null {
  if (!group.variant) return null;
  const chosen = values[join(group.path, group.variant.discriminator)];
  return group.variant.options.find((o) => o.value === chosen) ?? null;
}

function valueAt(settings: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((obj, key) => (obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined), settings);
}

/** Form values for stored settings (edit) or an empty form (blank = default applies). */
export function initialSettingsValues(group: SettingsGroup, settings: Record<string, unknown> | null): FormValues {
  const values: FormValues = {};
  const walk = (g: SettingsGroup) => {
    if (g.variant) {
      const stored = settings ? valueAt(settings, join(g.path, g.variant.discriminator)) : undefined;
      values[join(g.path, g.variant.discriminator)] = typeof stored === 'string' ? stored : '';
      g.variant.options.forEach((o) => walk(o.group));
      return;
    }
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
    if (g.variant) {
      const chosen = chosenVariant(g, values);
      return chosen ? { [g.variant.discriminator]: chosen.value, ...build(chosen.group) } : {};
    }
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

/** A descriptor setup file (`setupFiles`): a text template, or an `application/zip` package the API builds. */
export interface SetupFileDef {
  key: string;
  label: string;
  description?: string | undefined;
  filename: string;
  contentType: 'application/json' | 'text/yaml' | 'text/plain' | 'application/zip';
  template?: string | undefined;
  entries?: ReadonlyArray<{ path: string; contentType: string; template?: string | undefined; base64?: string | undefined }> | undefined;
}

export interface SetupContext {
  webhookUrl: string | null;
  settings: Record<string, unknown>;
}

const SETUP_PLACEHOLDER = /\{\{\s*(webhookUrl|webhookHost|settings\.[A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}/g;
/** YAML / plain text: values that are one plain scalar whatever surrounds them (no quotes, comments, flow or block syntax). */
const PLAIN_SAFE = /^[A-Za-z0-9][A-Za-z0-9 ._~:/?=&%+@,()-]*$/;

/**
 * Fill a template's placeholders from the saved channel. Only `{{webhookUrl}}`, `{{webhookHost}}` and
 * `{{settings.<key>}}` exist (the descriptor contract never interpolates secrets). Values go in as plain text:
 * JSON-string-escaped for JSON; for YAML and plain text a value that could change the file's structure is left
 * out. A missing or left-out value keeps its placeholder and is listed in `missing`.
 */
export function fillTemplate(template: string, contentType: string, ctx: SetupContext): { content: string; missing: string[] } {
  const missing = new Set<string>();
  const host = ctx.webhookUrl && URL.canParse(ctx.webhookUrl) ? new URL(ctx.webhookUrl).host : null;
  const content = template.replace(SETUP_PLACEHOLDER, (token, name: string) => {
    const raw = name === 'webhookUrl' ? ctx.webhookUrl : name === 'webhookHost' ? host : ctx.settings[name.slice('settings.'.length)];
    const value = typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : '';
    if (!value) {
      missing.add(name);
      return token;
    }
    if (contentType === 'application/json') return JSON.stringify(value).slice(1, -1);
    if (!PLAIN_SAFE.test(value) || value.includes(': ') || value.includes(' #')) {
      missing.add(name);
      return token;
    }
    return value;
  });
  return { content, missing: [...missing] };
}

/**
 * A setup file filled from the saved channel: a text file's content, or for a zip package the first text entry
 * (its manifest, as a preview; the API builds the zip). `missing` covers every entry.
 */
export function renderSetupFile(file: SetupFileDef, ctx: SetupContext): { content: string; missing: string[]; preview: string | null } {
  if (file.contentType !== 'application/zip') {
    const out = fillTemplate(file.template ?? '', file.contentType, ctx);
    return { ...out, preview: file.filename };
  }
  const missing = new Set<string>();
  let content = '';
  let preview: string | null = null;
  for (const entry of file.entries ?? []) {
    if (typeof entry.template !== 'string') continue;
    const out = fillTemplate(entry.template, entry.contentType, ctx);
    out.missing.forEach((m) => missing.add(m));
    if (preview === null) {
      preview = entry.path;
      content = out.content;
    }
  }
  return { content, missing: [...missing], preview };
}

/** Where the browser downloads a setup file the API renders (the BFF proxies it with the session). */
export function setupFileDownloadHref(channelId: string, key: string): string {
  return `/api/channels/${encodeURIComponent(channelId)}/setup-files/${encodeURIComponent(key)}`;
}

/** A guide link is rendered only when it is https (the registry refuses others; checked again here). */
export function safeHttpsHref(href: string): string | null {
  if (!URL.canParse(href)) return null;
  const url = new URL(href);
  return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
}

/** The secrets a kind requires that the channel does not hold yet (a draft saved before the provider's values existed). */
export function missingRequiredSecrets(fields: ReadonlyArray<{ key: string; label: string; required: boolean; generate?: string | undefined }>, stored: ReadonlySet<string>): string[] {
  return fields.filter((f) => f.required && f.generate !== 'server' && !stored.has(f.key)).map((f) => f.label);
}
