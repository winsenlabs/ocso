import type { ChannelKindDescriptor, ChannelSetupFile, ChannelSetupStep } from './descriptor.js';

/**
 * Checks and rendering for a kind's setup files and setup guide (descriptor `setupFiles`, `setupGuide`,
 * `troubleshooting`). The registry refuses a kind with problems; the API renders files from a channel.
 */

/** `{{webhookUrl}}`, `{{webhookHost}}` or `{{settings.<key>}}`: the only placeholders a setup file or guide value may use. */
export const SETUP_FILE_PLACEHOLDER = /\{\{\s*(webhookUrl|webhookHost|settings\.[A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}/g;
const ONE_PLACEHOLDER = new RegExp(`^${SETUP_FILE_PLACEHOLDER.source}$`);
const ANY_PLACEHOLDER = /\{\{([^}]*)\}\}/g;
const SETUP_FILE_KEY = /^[a-z][a-z0-9-]{0,39}$/;
const SETUP_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const TEXT_TYPES: ReadonlySet<string> = new Set(['application/json', 'text/yaml', 'text/plain']);
const SETUP_FILE_TYPES: ReadonlySet<string> = new Set([...TEXT_TYPES, 'application/zip']);
const ENTRY_TYPES: ReadonlySet<string> = new Set([...TEXT_TYPES, 'image/png']);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_SETUP_FILE_BYTES = 64 * 1024;
const MAX_PACKAGE_BYTES = 256 * 1024;
const TROUBLESHOOTING_ID = /^[a-z][a-z0-9-]{0,39}$/;

function placeholderProblems(text: string, at: string): string[] {
  const problems: string[] = [];
  for (const match of text.matchAll(ANY_PLACEHOLDER)) {
    if (!ONE_PLACEHOLDER.test(match[0])) problems.push(`${at}: unknown placeholder ${match[0]} (only {{webhookUrl}}, {{webhookHost}} and {{settings.<key>}}; secrets are never interpolated)`);
  }
  return problems;
}

/** Problems with a kind's setup files (registration refuses the kind when there are any). */
export function setupFileProblems(files: readonly ChannelSetupFile[] | undefined): string[] {
  if (files === undefined) return [];
  if (!Array.isArray(files)) return ['setupFiles must be an array'];
  const problems: string[] = [];
  const keys = new Set<string>();
  files.forEach((file, i) => {
    const at = `setupFiles[${i}]`;
    if (typeof file?.key !== 'string' || !SETUP_FILE_KEY.test(file.key)) problems.push(`${at}: invalid key "${String(file?.key)}"`);
    else if (keys.has(file.key)) problems.push(`${at}: duplicate key "${file.key}"`);
    else keys.add(file.key);
    if (typeof file?.label !== 'string' || !file.label.trim()) problems.push(`${at}: label is required`);
    if (typeof file?.filename !== 'string' || !SETUP_FILE_NAME.test(file.filename)) problems.push(`${at}: invalid filename "${String(file?.filename)}"`);
    if (!SETUP_FILE_TYPES.has(file?.contentType)) return void problems.push(`${at}: contentType must be application/json, text/yaml, text/plain or application/zip`);
    if (file.contentType === 'application/zip') return void problems.push(...packageProblems(file, at));
    if (typeof file?.template !== 'string' || !file.template.length) return void problems.push(`${at}: template is required`);
    if (file.entries !== undefined) problems.push(`${at}: only application/zip files have entries`);
    if (new TextEncoder().encode(file.template).byteLength > MAX_SETUP_FILE_BYTES) problems.push(`${at}: template exceeds 64 KiB`);
    problems.push(...placeholderProblems(file.template, at));
  });
  return problems;
}

function packageProblems(file: ChannelSetupFile, at: string): string[] {
  if (file.template !== undefined) return [`${at}: an application/zip file has entries, not a template`];
  if (!Array.isArray(file.entries) || !file.entries.length || file.entries.length > 20) return [`${at}: entries must list 1–20 files`];
  const problems: string[] = [];
  const paths = new Set<string>();
  let bytes = 0;
  file.entries.forEach((entry, j) => {
    const where = `${at}.entries[${j}]`;
    if (typeof entry?.path !== 'string' || !SETUP_FILE_NAME.test(entry.path)) problems.push(`${where}: invalid path "${String(entry?.path)}"`);
    else if (paths.has(entry.path)) problems.push(`${where}: duplicate path "${entry.path}"`);
    else paths.add(entry.path);
    if (!ENTRY_TYPES.has(entry?.contentType)) return void problems.push(`${where}: contentType must be application/json, text/yaml, text/plain or image/png`);
    if (entry.contentType === 'image/png') {
      if (typeof entry.base64 !== 'string' || !BASE64.test(entry.base64) || entry.template !== undefined) return void problems.push(`${where}: an image/png entry carries base64 bytes only`);
      bytes += Math.floor((entry.base64.length * 3) / 4);
      return;
    }
    if (typeof entry.template !== 'string' || !entry.template.length || entry.base64 !== undefined) return void problems.push(`${where}: a text entry carries a template only`);
    bytes += new TextEncoder().encode(entry.template).byteLength;
    problems.push(...placeholderProblems(entry.template, where));
  });
  if (bytes > MAX_PACKAGE_BYTES) problems.push(`${at}: entries exceed 256 KiB`);
  return problems;
}

const isText = (value: unknown, max: number, required = true): value is string => typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0);
function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 2048 || !URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}

/**
 * Problems with a kind's setup guide and troubleshooting (registration refuses the kind when there are any).
 * Plain text within limits, https links only, placeholders as in setup files, `files` naming setup files that
 * exist, at most one `form` step, unique troubleshooting ids.
 */
export function setupGuideProblems(descriptor: Pick<ChannelKindDescriptor, 'setupSteps' | 'setupGuide' | 'troubleshooting' | 'setupFiles'>): string[] {
  const problems: string[] = [];
  const { setupSteps, setupGuide, troubleshooting } = descriptor;
  if (setupSteps !== undefined && (!Array.isArray(setupSteps) || setupSteps.length > 30 || !setupSteps.every((s) => isText(s, 2000)))) problems.push('setupSteps must be up to 30 non-empty strings');
  const fileKeys = new Set((Array.isArray(descriptor.setupFiles) ? descriptor.setupFiles : []).map((f) => f?.key));
  if (setupGuide !== undefined) {
    if (!Array.isArray(setupGuide) || setupGuide.length > 30) problems.push('setupGuide must be an array of up to 30 steps');
    else {
      let forms = 0;
      setupGuide.forEach((step, i) => {
        const at = `setupGuide[${i}]`;
        if (typeof step !== 'object' || step === null) return void problems.push(`${at}: must be an object`);
        if (!isText(step.title, 120)) problems.push(`${at}: title is required (up to 120 characters)`);
        if (!isText(step.body, 2000, false)) problems.push(`${at}: body must be a string (up to 2000 characters)`);
        if (step.items !== undefined && (!Array.isArray(step.items) || step.items.length > 20 || !step.items.every((t: unknown) => isText(t, 500)))) problems.push(`${at}: items must be up to 20 strings`);
        if (step.table !== undefined) {
          const t = step.table;
          const pair = (row: unknown) => Array.isArray(row) && row.length === 2 && row.every((c) => isText(c, 300));
          if (typeof t !== 'object' || t === null || !pair(t.head) || !Array.isArray(t.rows) || !t.rows.length || t.rows.length > 30 || !t.rows.every(pair)) problems.push(`${at}: table needs a two-column head and 1–30 two-column rows`);
        }
        if (step.values !== undefined) {
          if (!Array.isArray(step.values) || step.values.length > 10) problems.push(`${at}: values must be up to 10 entries`);
          else
            step.values.forEach((v: { label?: unknown; value?: unknown } | undefined, j: number) => {
              if (!isText(v?.label, 80) || !isText(v?.value, 2000)) problems.push(`${at}.values[${j}]: label and value are required`);
              else problems.push(...placeholderProblems(v!.value as string, `${at}.values[${j}]`));
            });
        }
        if (step.links !== undefined) {
          if (!Array.isArray(step.links) || step.links.length > 8) problems.push(`${at}: links must be up to 8 entries`);
          else step.links.forEach((l: { label?: unknown; href?: unknown } | undefined, j: number) => (!isText(l?.label, 80) || !isHttpsUrl(l?.href) ? problems.push(`${at}.links[${j}]: needs a label and an https href`) : undefined));
        }
        if (step.files !== undefined) {
          if (!Array.isArray(step.files)) problems.push(`${at}: files must be an array of setup file keys`);
          else for (const key of step.files) if (!fileKeys.has(key)) problems.push(`${at}: files names unknown setup file "${String(key)}"`);
        }
        if (step.form !== undefined && typeof step.form !== 'boolean') problems.push(`${at}: form must be a boolean`);
        if (step.form === true) forms++;
        if (step.check !== undefined && !isText(step.check, 500)) problems.push(`${at}: check must be a string (up to 500 characters)`);
      });
      if (forms > 1) problems.push('setupGuide: at most one step has form: true');
    }
  }
  if (troubleshooting !== undefined) {
    if (!Array.isArray(troubleshooting) || troubleshooting.length > 40) problems.push('troubleshooting must be an array of up to 40 entries');
    else {
      const ids = new Set<string>();
      troubleshooting.forEach((t, i) => {
        const at = `troubleshooting[${i}]`;
        if (typeof t?.id !== 'string' || !TROUBLESHOOTING_ID.test(t.id)) problems.push(`${at}: invalid id "${String(t?.id)}"`);
        else if (ids.has(t.id)) problems.push(`${at}: duplicate id "${t.id}"`);
        else ids.add(t.id);
        if (!isText(t?.problem, 200)) problems.push(`${at}: problem is required (up to 200 characters)`);
        if (!isText(t?.fix, 2000)) problems.push(`${at}: fix is required (up to 2000 characters)`);
      });
    }
  }
  return problems;
}

/** The guide a kind serves: its `setupGuide`, else one step per deprecated `setupSteps` sentence. */
export function setupGuideOf(descriptor: Pick<ChannelKindDescriptor, 'setupSteps' | 'setupGuide'>): readonly ChannelSetupStep[] {
  if (descriptor.setupGuide?.length) return descriptor.setupGuide;
  return (descriptor.setupSteps ?? []).map((sentence) => ({ title: sentence, body: '' }));
}

/** What a setup file's placeholders are filled from: the channel's webhook URL and non-secret settings. */
export interface SetupFileContext {
  webhookUrl: string | null;
  settings: Readonly<Record<string, unknown>>;
}

/** YAML / plain text: values that are one plain scalar whatever surrounds them (no quotes, comments, flow or block syntax). */
const PLAIN_SAFE = /^[A-Za-z0-9][A-Za-z0-9 ._~:/?=&%+@,()-]*$/;

/**
 * Fill a template's placeholders. JSON: values are string-escaped. YAML / plain text: a value that could change
 * the file's structure is left out. A missing or left-out value keeps its placeholder and is listed in `missing`.
 */
export function fillSetupTemplate(template: string, contentType: string, ctx: SetupFileContext): { content: string; missing: string[] } {
  const missing = new Set<string>();
  const host = ctx.webhookUrl && URL.canParse(ctx.webhookUrl) ? new URL(ctx.webhookUrl).host : null;
  const content = template.replace(SETUP_FILE_PLACEHOLDER, (token, name: string) => {
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
 * A setup file's files, filled: one file for text types, the package's entries for `application/zip` (the caller
 * zips them). `missing` lists placeholders no value could fill; a package with any is not ready to download.
 */
export function renderSetupFile(file: ChannelSetupFile, ctx: SetupFileContext): { files: Array<{ path: string; data: Uint8Array }>; missing: string[] } {
  const encoder = new TextEncoder();
  if (file.contentType !== 'application/zip') {
    const { content, missing } = fillSetupTemplate(file.template ?? '', file.contentType, ctx);
    return { files: [{ path: file.filename, data: encoder.encode(content) }], missing };
  }
  const missing = new Set<string>();
  const files = (file.entries ?? []).map((entry) => {
    if (entry.contentType === 'image/png') return { path: entry.path, data: Uint8Array.from(atob(entry.base64 ?? ''), (c) => c.charCodeAt(0)) };
    const filled = fillSetupTemplate(entry.template ?? '', entry.contentType, ctx);
    filled.missing.forEach((m) => missing.add(m));
    return { path: entry.path, data: encoder.encode(filled.content) };
  });
  return { files, missing: [...missing] };
}
