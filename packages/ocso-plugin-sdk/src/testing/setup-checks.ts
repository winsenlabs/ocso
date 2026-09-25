import { SETUP_FILE_KEY_PATTERN, SETUP_FILE_NAME_PATTERN, SETUP_FILE_PLACEHOLDER_PATTERN, TROUBLESHOOTING_ID_PATTERN } from '../patterns.js';

/**
 * The channel registry's checks of a descriptor's `setupFiles`, `setupGuide` and `troubleshooting`, copied so a
 * plugin author can run them without a host. A repo test keeps them in agreement with the registry.
 */

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null;

const TEXT_TYPES = new Set(['application/json', 'text/yaml', 'text/plain']);
const SETUP_FILE_TYPES = new Set([...TEXT_TYPES, 'application/zip']);
const ENTRY_TYPES = new Set([...TEXT_TYPES, 'image/png']);
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function checkPlaceholders(text: string, at: string, problems: string[]): void {
  for (const match of text.matchAll(/\{\{[^}]*\}\}/g)) {
    if (!SETUP_FILE_PLACEHOLDER_PATTERN.test(match[0])) problems.push(`${at}: unknown placeholder ${match[0]} (only {{webhookUrl}}, {{webhookHost}} and {{settings.<key>}}; secrets are never interpolated)`);
  }
}

/** Descriptor `setupFiles`: keys, labels, file names, content types, size and placeholders; zip packages' entries. */
export function checkSetupFiles(files: unknown, label: string, problems: string[]): void {
  if (files === undefined) return;
  if (!Array.isArray(files)) return void problems.push(`${label}: setupFiles must be an array`);
  const keys = new Set<string>();
  files.forEach((file: unknown, i) => {
    const at = `${label}: setupFiles[${i}]`;
    if (!isObject(file)) return void problems.push(`${at}: must be an object`);
    const key = file['key'];
    if (typeof key !== 'string' || !SETUP_FILE_KEY_PATTERN.test(key)) problems.push(`${at}: invalid key "${String(key)}"`);
    else if (keys.has(key)) problems.push(`${at}: duplicate key "${key}"`);
    else keys.add(key);
    if (typeof file['label'] !== 'string' || !file['label'].trim()) problems.push(`${at}: label is required`);
    if (typeof file['filename'] !== 'string' || !SETUP_FILE_NAME_PATTERN.test(file['filename'])) problems.push(`${at}: invalid filename "${String(file['filename'])}"`);
    if (!SETUP_FILE_TYPES.has(file['contentType'] as string)) return void problems.push(`${at}: contentType must be application/json, text/yaml, text/plain or application/zip`);
    if (file['contentType'] === 'application/zip') return void checkPackage(file, at, problems);
    const template = file['template'];
    if (typeof template !== 'string' || !template.length) return void problems.push(`${at}: template is required`);
    if (file['entries'] !== undefined) problems.push(`${at}: only application/zip files have entries`);
    if (new TextEncoder().encode(template).byteLength > 64 * 1024) problems.push(`${at}: template exceeds 64 KiB`);
    checkPlaceholders(template, at, problems);
  });
}

function checkPackage(file: Obj, at: string, problems: string[]): void {
  if (file['template'] !== undefined) return void problems.push(`${at}: an application/zip file has entries, not a template`);
  const entries = file['entries'];
  if (!Array.isArray(entries) || !entries.length || entries.length > 20) return void problems.push(`${at}: entries must list 1–20 files`);
  const paths = new Set<string>();
  let bytes = 0;
  entries.forEach((entry: unknown, j) => {
    const where = `${at}.entries[${j}]`;
    if (!isObject(entry)) return void problems.push(`${where}: must be an object`);
    const path = entry['path'];
    if (typeof path !== 'string' || !SETUP_FILE_NAME_PATTERN.test(path)) problems.push(`${where}: invalid path "${String(path)}"`);
    else if (paths.has(path)) problems.push(`${where}: duplicate path "${path}"`);
    else paths.add(path);
    const type = entry['contentType'];
    if (!ENTRY_TYPES.has(type as string)) return void problems.push(`${where}: contentType must be application/json, text/yaml, text/plain or image/png`);
    if (type === 'image/png') {
      const b64 = entry['base64'];
      if (typeof b64 !== 'string' || !BASE64_PATTERN.test(b64) || entry['template'] !== undefined) return void problems.push(`${where}: an image/png entry carries base64 bytes only`);
      bytes += Math.floor((b64.length * 3) / 4);
      return;
    }
    const template = entry['template'];
    if (typeof template !== 'string' || !template.length || entry['base64'] !== undefined) return void problems.push(`${where}: a text entry carries a template only`);
    bytes += new TextEncoder().encode(template).byteLength;
    checkPlaceholders(template, where, problems);
  });
  if (bytes > 256 * 1024) problems.push(`${at}: entries exceed 256 KiB`);
}

const isText = (value: unknown, max: number, required = true): value is string => typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0);
function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 2048 || !URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}

/** Descriptor `setupSteps` (deprecated), `setupGuide` and `troubleshooting`: plain text in limits, https links, known files. */
export function checkSetupGuide(descriptor: Obj, label: string, problems: string[]): void {
  const steps = descriptor['setupSteps'];
  if (steps !== undefined && (!Array.isArray(steps) || steps.length > 30 || !steps.every((s: unknown) => isText(s, 2000)))) problems.push(`${label}: setupSteps must be up to 30 non-empty strings`);
  const files = Array.isArray(descriptor['setupFiles']) ? (descriptor['setupFiles'] as unknown[]) : [];
  const fileKeys = new Set(files.map((f) => (isObject(f) ? f['key'] : undefined)));
  const guide = descriptor['setupGuide'];
  if (guide !== undefined) {
    if (!Array.isArray(guide) || guide.length > 30) problems.push(`${label}: setupGuide must be an array of up to 30 steps`);
    else {
      let forms = 0;
      guide.forEach((step: unknown, i) => {
        const at = `${label}: setupGuide[${i}]`;
        if (!isObject(step)) return void problems.push(`${at}: must be an object`);
        if (!isText(step['title'], 120)) problems.push(`${at}: title is required (up to 120 characters)`);
        if (!isText(step['body'], 2000, false)) problems.push(`${at}: body must be a string (up to 2000 characters)`);
        const items = step['items'];
        if (items !== undefined && (!Array.isArray(items) || items.length > 20 || !items.every((t: unknown) => isText(t, 500)))) problems.push(`${at}: items must be up to 20 strings`);
        const table = step['table'];
        if (table !== undefined) {
          const pair = (row: unknown) => Array.isArray(row) && row.length === 2 && row.every((c: unknown) => isText(c, 300));
          const rows = isObject(table) ? table['rows'] : undefined;
          if (!isObject(table) || !pair(table['head']) || !Array.isArray(rows) || !rows.length || rows.length > 30 || !rows.every(pair)) problems.push(`${at}: table needs a two-column head and 1–30 two-column rows`);
        }
        const values = step['values'];
        if (values !== undefined) {
          if (!Array.isArray(values) || values.length > 10) problems.push(`${at}: values must be up to 10 entries`);
          else
            values.forEach((v: unknown, j) => {
              if (!isObject(v) || !isText(v['label'], 80) || !isText(v['value'], 2000)) problems.push(`${at}.values[${j}]: label and value are required`);
              else checkPlaceholders(v['value'] as string, `${at}.values[${j}]`, problems);
            });
        }
        const links = step['links'];
        if (links !== undefined) {
          if (!Array.isArray(links) || links.length > 8) problems.push(`${at}: links must be up to 8 entries`);
          else links.forEach((l: unknown, j) => (!isObject(l) || !isText(l['label'], 80) || !isHttpsUrl(l['href']) ? problems.push(`${at}.links[${j}]: needs a label and an https href`) : undefined));
        }
        const stepFiles = step['files'];
        if (stepFiles !== undefined) {
          if (!Array.isArray(stepFiles)) problems.push(`${at}: files must be an array of setup file keys`);
          else for (const key of stepFiles) if (!fileKeys.has(key)) problems.push(`${at}: files names unknown setup file "${String(key)}"`);
        }
        if (step['form'] !== undefined && typeof step['form'] !== 'boolean') problems.push(`${at}: form must be a boolean`);
        if (step['form'] === true) forms++;
        if (step['check'] !== undefined && !isText(step['check'], 500)) problems.push(`${at}: check must be a string (up to 500 characters)`);
      });
      if (forms > 1) problems.push(`${label}: setupGuide: at most one step has form: true`);
    }
  }
  const troubleshooting = descriptor['troubleshooting'];
  if (troubleshooting !== undefined) {
    if (!Array.isArray(troubleshooting) || troubleshooting.length > 40) problems.push(`${label}: troubleshooting must be an array of up to 40 entries`);
    else {
      const ids = new Set<string>();
      troubleshooting.forEach((t: unknown, i) => {
        const at = `${label}: troubleshooting[${i}]`;
        const id = isObject(t) ? t['id'] : undefined;
        if (typeof id !== 'string' || !TROUBLESHOOTING_ID_PATTERN.test(id)) problems.push(`${at}: invalid id "${String(id)}"`);
        else if (ids.has(id)) problems.push(`${at}: duplicate id "${id}"`);
        else ids.add(id);
        if (!isObject(t) || !isText(t['problem'], 200)) problems.push(`${at}: problem is required (up to 200 characters)`);
        if (!isObject(t) || !isText(t['fix'], 2000)) problems.push(`${at}: fix is required (up to 2000 characters)`);
      });
    }
  }
}

