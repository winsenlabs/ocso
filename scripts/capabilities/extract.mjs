/**
 * Ask OCSO capability catalog extractor (PM/research/12 §3).
 *
 * Two passes over the API, both from the real code so the catalog never drifts:
 *   1. Runtime: the Nest controllers are loaded (through Vite's module runner, or
 *      Vitest in the staleness test) and their route metadata is read: method,
 *      path, access rule (@RequirePermission / @RequireAnyPermission), the zod
 *      schemas of @Param/@Query/@Body (→ JSON Schema with z.toJSONSchema) and
 *      @Capability options.
 *   2. Static: the TypeScript compiler API (typescript/unstable/sync, TS 7) reads
 *      each handler's doc comment (summary, details) and resolves the approval
 *      descriptor kind the handler names (`objectKind: 'agent'`, constants too,
 *      through the checker).
 *
 * The internal agent's read-only insight tools join as `insight.*` entries and
 * `ui.open_page` as a link card over the web app's signed-in pages.
 *
 * `extractCatalog()` returns the catalog object written to
 * packages/internal-agent/src/catalog/capabilities.generated.json.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PARAMTYPE, inputOf, isSecretField, makeJsonSchema, nestedProperties } from './schemas.mjs';
import { appRoutes as pageRoutes, readSources } from './sources.mjs';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
export const CATALOG_PATH = join(REPO_ROOT, 'packages/internal-agent/src/catalog/capabilities.generated.json');
const API_ROOT = join(REPO_ROOT, 'apps/api');
const MODULES_DIR = join(API_ROOT, 'src/modules');
const WEB_APP_DIR = join(REPO_ROOT, 'apps/web/app');

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

/**
 * Routes left out without an annotation, by rule (BUILD.md "Excluded routes").
 * First match wins; anything else must be in the catalog or carry `@Capability({ exclude })`.
 */
const EXCLUDE_RULES = [
  { test: (r) => /^\/channels\/.*\/webhook$/.test(r.path), reason: 'channel webhook (provider ingress, signature-checked)' },
  { test: (r) => /^\/public\//.test(r.path), reason: 'public web chat ingress' },
  { test: (r) => /^\/oauth\//.test(r.path), reason: 'OAuth callback' },
  { test: (r) => /^\/blobs\//.test(r.path), reason: 'blob download' },
  { test: (r) => /^\/v1\/(auth|setup)(\/|$)/.test(r.path), reason: 'auth, session, sign-in, MFA or setup' },
  { test: (r) => /^\/v1\/internal-agent(\/|$)/.test(r.path), reason: "the internal agent's own routes" },
  { test: (r) => /^\/v1\/test-hooks(\/|$)/.test(r.path), reason: 'dev-only test hooks' },
  { test: (r) => r.access?.kind === 'public', reason: 'public route (no session)' },
  { test: (r) => r.sse, reason: 'SSE stream' },
  { test: (r) => r.rawResponse, reason: 'writes the raw response (download or stream)' },
  { test: (r) => r.rawRequest, reason: 'reads the raw request (file upload or streamed body)' },
];

/** Search nouns per API module (the runtime adds general synonyms on top). */
const MODULE_TAGS = {
  agents: ['agent', 'virtual agent', 'bot', 'ai'],
  alerts: ['alert', 'notification', 'incident'],
  analytics: ['analytics', 'report', 'metrics', 'performance'],
  approvals: ['approval', 'proposal', 'maker-checker', 'review'],
  audit: ['audit', 'log', 'history'],
  channels: ['channel', 'whatsapp', 'email', 'web chat', 'inbox'],
  conversations: ['conversation', 'ticket', 'chat', 'case', 'customer message'],
  copilot: ['copilot', 'suggestion', 'draft reply'],
  customers: ['customer', 'contact', 'end user'],
  exceptions: ['exception', 'exception report', 'compliance'],
  health: ['health', 'status', 'dependencies'],
  mcp: ['mcp', 'connection', 'integration', 'tools'],
  models: ['model', 'llm', 'provider', 'ai model'],
  plugins: ['plugin', 'extension'],
  quality: ['quality', 'qa', 'review', 'evaluation'],
  routers: ['router', 'routing', 'entry point'],
  routing: ['queue', 'routing', 'sla'],
  security: ['security', 'keys', 'secrets'],
  settings: ['settings', 'configuration', 'deployment'],
  telemetry: ['telemetry', 'latency', 'usage', 'system'],
  users: ['user', 'team', 'staff', 'member', 'role', 'permission'],
  webhooks: ['webhook', 'event', 'integration'],
};

/** API path → web page, first match wins (`:param` names are the API route's). */
const UI_HREFS = [
  [/^\/v1\/agents\/:(\w+)/, (m) => `/agents/:${m[1]}`],
  [/^\/v1\/agents$/, () => '/agents'],
  [/^\/v1\/conversations\/:(\w+)/, (m) => `/conversations/:${m[1]}`],
  [/^\/v1\/conversations$/, () => '/conversations'],
  [/^\/v1\/routers\/:(\w+)/, (m) => `/routers/:${m[1]}`],
  [/^\/v1\/routers/, () => '/routers'],
  [/^\/v1\/queues/, () => '/queues'],
  [/^\/v1\/sla-policies/, () => '/sla'],
  [/^\/v1\/approvals/, () => '/approvals'],
  [/^\/v1\/audit/, () => '/audit'],
  [/^\/v1\/(alerts|alert-rules|notification-destinations)/, () => '/alerts'],
  [/^\/v1\/exceptions\/reports\/:(\w+)/, (m) => `/exceptions/reports/:${m[1]}`],
  [/^\/v1\/exceptions/, () => '/exceptions'],
  [/^\/v1\/customers/, () => '/customers'],
  [/^\/v1\/(users|teams)/, () => '/team'],
  [/^\/v1\/corrections/, () => '/corrections'],
  [/^\/v1\/(reviews|evaluations)/, () => '/reviews'],
  [/^\/v1\/(channels\/:\w+\/templates|message-templates)/, () => '/templates'],
  [/^\/v1\/mcp\//, () => '/connections'],
  [/^\/v1\/analytics\/escalation-reasons/, () => '/escalation-reasons'],
  [/^\/v1\/analytics/, () => '/analytics'],
  [/^\/v1\/telemetry/, () => '/system/telemetry'],
  [/^\/v1\/settings\/workers/, () => '/system/workers'],
  [/^\/v1\/(system|health)/, () => '/system'],
  [/^\/v1\/(channels|model-\w+|webhooks|webhook-deliveries|settings|security|secrets)/, () => '/settings'],
  [/^\/v1\/home$/, () => '/'],
];

/* ───────────────────────── runtime pass ───────────────────────── */

async function loadRuntime() {
  const apiRequire = createRequire(join(API_ROOT, 'package.json'));
  await import(pathToFileURL(apiRequire.resolve('reflect-metadata')).href);
  const constants = await import(pathToFileURL(apiRequire.resolve('@nestjs/common/constants.js')).href);
  // zod's ESM entry (the CommonJS one cannot be inlined by the module runner); the global registry is shared.
  const { z } = await import(pathToFileURL(join(dirname(apiRequire.resolve('zod/package.json')), 'index.js')).href);
  const { FEATURE_MODULES } = await import(pathToFileURL(join(API_ROOT, 'src/app.module.ts')).href);
  const { ACCESS_KEY, CAPABILITY_KEY } = await import(pathToFileURL(join(API_ROOT, 'src/common/decorators.ts')).href);
  const application = await import(pathToFileURL(join(REPO_ROOT, 'packages/application/src/index.ts')).href);
  const auth = await import(pathToFileURL(join(REPO_ROOT, 'packages/auth/src/index.ts')).href);
  const insight = await import(pathToFileURL(join(REPO_ROOT, 'packages/internal-agent/src/registry.ts')).href);
  return { constants, z, FEATURE_MODULES, ACCESS_KEY, CAPABILITY_KEY, application, auth, insight };
}

function joinPath(base, sub) {
  const parts = [base, sub].map((s) => String(s ?? '').replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return `/${parts.join('/')}`;
}

function collectRoutes(rt) {
  const { MODULE_METADATA, PATH_METADATA, METHOD_METADATA, ROUTE_ARGS_METADATA, SSE_METADATA, RESPONSE_PASSTHROUGH_METADATA } = rt.constants;
  const routes = [];
  for (const mod of rt.FEATURE_MODULES) {
    for (const controller of Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, mod) ?? []) {
      const bases = [].concat(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
      const classCap = Reflect.getMetadata(rt.CAPABILITY_KEY, controller) ?? {};
      const proto = controller.prototype;
      for (const handlerName of Object.getOwnPropertyNames(proto)) {
        const handler = proto[handlerName];
        if (handlerName === 'constructor' || typeof handler !== 'function' || !Reflect.hasMetadata(METHOD_METADATA, handler)) continue;
        const method = HTTP_METHODS[Reflect.getMetadata(METHOD_METADATA, handler)];
        const subs = [].concat(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
        const access = Reflect.getMetadata(rt.ACCESS_KEY, handler) ?? Reflect.getMetadata(rt.ACCESS_KEY, controller);
        const cap = { ...classCap, ...(Reflect.getMetadata(rt.CAPABILITY_KEY, handler) ?? {}) };
        const rawArgs = Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, handlerName) ?? {};
        const args = Object.entries(rawArgs).map(([key, value]) => ({ type: Number(key.split(':')[0]), custom: key.includes('__customRouteArgs__'), ...value }));
        const passthrough = Reflect.getMetadata(RESPONSE_PASSTHROUGH_METADATA, controller, handlerName) === true;
        const hasRes = args.some((a) => !a.custom && a.type === PARAMTYPE.RESPONSE);
        const hasReq = args.some((a) => !a.custom && a.type === PARAMTYPE.REQUEST);
        const hasBodySchema = args.some((a) => !a.custom && a.type === PARAMTYPE.BODY && a.schema);
        for (const base of bases) {
          for (const sub of subs) {
            routes.push({
              controller: controller.name,
              handler: handlerName,
              method,
              path: joinPath(base, sub),
              access,
              cap,
              args,
              sse: Boolean(Reflect.getMetadata(SSE_METADATA, handler)),
              rawResponse: hasRes && !passthrough,
              // A raw request with no validated body: uploads (headers + stream) and the like.
              rawRequest: args.some((a) => !a.custom && (a.type === PARAMTYPE.FILE || a.type === PARAMTYPE.FILES || a.type === PARAMTYPE.RAW_BODY)) || (hasReq && method !== 'GET' && !hasBodySchema),
            });
          }
        }
      }
    }
  }
  return routes;
}

/* ───────────────────────── names, tags, summaries ───────────────────────── */

const snake = (s) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

function singular(word) {
  if (/ies$/.test(word)) return word.replace(/ies$/, 'y');
  if (/(ss|us)$/.test(word)) return word;
  if (/(sh|ch|x|ses)$/.test(word) && /es$/.test(word)) return word.replace(/es$/, '');
  return word.replace(/s$/, '');
}

function controllerNoun(controllerName) {
  const words = snake(controllerName.replace(/Controller$/, '')).split('_');
  const last = words.pop() ?? '';
  return { plural: [...words, last].join('_'), singular: [...words, singular(last)].join('_') };
}

function defaultName(module, route) {
  const noun = controllerNoun(route.controller);
  const h = snake(route.handler);
  let verbObject;
  if (h === 'list') verbObject = `list_${noun.plural}`;
  else if (h === 'get' || h === 'detail') verbObject = `get_${noun.singular}`;
  else if (['create', 'update', 'remove', 'delete'].includes(h)) verbObject = `${h === 'remove' ? 'delete' : h}_${noun.singular}`;
  else verbObject = h.includes(noun.singular) ? h : `${h}_${noun.singular}`;
  return `${snake(module)}.${verbObject}`;
}

function firstSentence(text) {
  const para = text.split('\n\n')[0];
  const m = para.match(/^(.+?[.!?])(\s|$)/);
  return (m ? m[1] : para).trim();
}

function tagsFor(module, route, capTags) {
  const words = new Set();
  const add = (w) => {
    const t = String(w).toLowerCase().trim();
    if (t && t.length > 1 && !/^v\d+$/.test(t)) words.add(t);
  };
  (capTags ?? []).forEach(add);
  (MODULE_TAGS[module] ?? [module]).forEach(add);
  for (const seg of route.path.split('/')) {
    if (!seg || seg.startsWith(':') || seg === 'v1') continue;
    for (const w of seg.split('-')) {
      add(w);
      add(singular(w));
    }
  }
  return [...words];
}

function uiHrefFor(path) {
  for (const [re, fn] of UI_HREFS) {
    const m = path.match(re);
    if (m) return fn(m);
  }
  return undefined;
}

/** Signed-in web pages as `/agents/:id` patterns: what `ui.open_page` may link to. */
export const appRoutes = () => pageRoutes(WEB_APP_DIR);

/* ───────────────────────── catalog ───────────────────────── */

const KEY_ORDER = ['name', 'method', 'path', 'permissions', 'summary', 'details', 'risk', 'stop', 'stopWhen', 'approvalKind', 'secretInputs', 'redactResponse', 'input', 'tags', 'uiHref'];

function ordered(cap) {
  const out = {};
  for (const k of KEY_ORDER) if (cap[k] !== undefined) out[k] = cap[k];
  return out;
}

/**
 * Build the catalog. Throws (with every problem listed) when a route cannot be classified:
 * missing summary, an approvable body without a resolvable kind, a duplicate name…
 */
export async function extractCatalog({ lenient = false } = {}) {
  const rt = await loadRuntime();
  const toJson = makeJsonSchema(rt.z);
  const sources = await readSources(REPO_ROOT, API_ROOT, MODULES_DIR);
  const approvalKinds = new Set(rt.application.createApprovalRegistry().kinds());
  const permissionValues = new Set(Object.values(rt.auth.Permission));
  const routes = collectRoutes(rt);
  const problems = [];
  const capabilities = [];
  const excluded = [];

  for (const route of routes) {
    const src = sources.get(route.controller);
    const where = `${route.method} ${route.path} (${route.controller}.${route.handler})`;
    if (!src) {
      problems.push(`${where}: controller source not found under apps/api/src/modules`);
      continue;
    }
    const rule = route.cap.exclude ? { reason: route.cap.exclude } : EXCLUDE_RULES.find((r) => r.test(route));
    if (rule) {
      excluded.push({ route: `${route.method} ${route.path}`, handler: `${route.controller}.${route.handler}`, reason: rule.reason });
      continue;
    }
    const meta = src.methods.get(route.handler) ?? { doc: undefined, kinds: [] };
    const doc = meta.doc;
    const summary = route.cap.summary ?? (doc ? firstSentence(doc) : undefined);
    if (!summary) problems.push(`${where}: no summary — add a doc comment or @Capability({ summary }) in ${src.file}`);

    const access = route.access;
    let permissions;
    if (access?.kind === 'permission') permissions = { mode: 'all', list: [access.permission] };
    else if (access?.kind === 'anyPermission') permissions = { mode: 'any', list: [...access.permissions] };
    else if (access?.kind === 'authenticated') permissions = { mode: 'all', list: [] };
    else problems.push(`${where}: no access rule the catalog understands (${JSON.stringify(access)})`);
    for (const p of permissions?.list ?? []) if (!permissionValues.has(p)) problems.push(`${where}: unknown permission ${p}`);

    const { input, governedBody } = inputOf(route, toJson);
    const secretInputs = [];
    if (input.body?.properties) {
      for (const [k, v] of Object.entries(input.body.properties)) {
        if (!isSecretField(k, v)) continue;
        if (input.body.required?.includes(k)) problems.push(`${where}: requires the credential field \`${k}\`; exclude it with @Capability({ exclude })`);
        delete input.body.properties[k];
        secretInputs.push(k);
      }
      if (secretInputs.length) input.body.additionalProperties = false;
    }
    const nestedSecrets = [...nestedProperties(input.query ?? {}), ...nestedProperties(input.body ?? {})].filter(([k, v]) => isSecretField(k, v)).map(([k]) => k);
    if (nestedSecrets.length) problems.push(`${where}: nested credential-like fields (${nestedSecrets.join(', ')}); exclude the route or review the pattern`);

    const write = route.method !== 'GET';
    const stop = route.cap.stop === true;
    const risk = route.cap.risk ?? (!write ? 'READ' : stop ? 'LOW_WRITE' : 'HIGH_WRITE');
    let approvalKind = route.cap.approvalKind;
    if (!approvalKind && write) {
      const kinds = meta.kinds.filter((k) => approvalKinds.has(k));
      if (kinds.length === 1) approvalKind = kinds[0];
      else if (kinds.length > 1) problems.push(`${where}: several approval kinds (${kinds.join(', ')}); name one with @Capability({ approvalKind })`);
    }
    if (governedBody && !approvalKind) problems.push(`${where}: body takes \`approval\` but no approval kind could be resolved; add @Capability({ approvalKind })`);
    if (approvalKind && !approvalKinds.has(approvalKind)) problems.push(`${where}: approval kind ${approvalKind} is not registered`);
    if (approvalKind && risk !== 'HIGH_WRITE') problems.push(`${where}: an approvable route must be HIGH_WRITE`);
    if (!write && (stop || approvalKind)) problems.push(`${where}: a GET cannot be a stop or approvable`);

    const detailsText = route.cap.details ?? doc;
    const details = detailsText && detailsText !== summary ? detailsText : undefined;
    const uiHref = route.cap.uiHref ?? uiHrefFor(route.path);
    capabilities.push(
      ordered({
        name: route.cap.name ?? defaultName(src.module, route),
        method: route.method,
        path: route.path,
        permissions,
        summary,
        details,
        risk,
        stop: stop || undefined,
        stopWhen: route.cap.stopWhen,
        approvalKind,
        secretInputs: secretInputs.length ? secretInputs.sort() : undefined,
        redactResponse: route.cap.redactResponse?.length ? [...route.cap.redactResponse].sort() : undefined,
        input,
        tags: tagsFor(src.module, route, route.cap.tags),
        uiHref,
      }),
    );
  }

  // Insight tools: the internal agent's cross-service reads (BUILD.md). Its write tools are not
  // carried over — those changes go through their API routes, where approvals and cards apply.
  const insightTools = rt.insight.INSIGHT_TOOLS ?? rt.insight.DEFAULT_TOOLS ?? [];
  for (const tool of insightTools) {
    if (tool.risk !== 'READ') continue;
    const description = String(tool.description ?? '').trim();
    const inputSchema = toJson(tool.input);
    const summary = firstSentence(description);
    capabilities.push(
      ordered({
        name: `insight.${tool.name}`,
        method: 'INSIGHT',
        path: `insight:${tool.name}`,
        permissions: { mode: 'all', list: [tool.permission] },
        summary,
        details: description !== summary ? description : undefined,
        risk: 'READ',
        input: inputSchema && Object.keys(inputSchema.properties ?? {}).length ? { body: inputSchema } : {},
        tags: ['insight', ...snake(tool.name).split('_').filter((w) => w.length > 2)],
      }),
    );
  }

  const pages = appRoutes();
  capabilities.push(
    ordered({
      name: 'ui.open_page',
      method: 'UI',
      path: 'ui:open_page',
      permissions: { mode: 'all', list: [] },
      summary: 'Open an OCSO page for the user (a link card), e.g. an agent, a conversation or the approvals queue.',
      details: `href must be one of the app's pages with ids filled in: ${pages.join(', ')}.`,
      risk: 'READ',
      input: {
        body: {
          type: 'object',
          properties: { href: { type: 'string', description: 'App path such as /agents/<id> or /approvals' }, label: { type: 'string', maxLength: 80 } },
          required: ['href'],
          additionalProperties: false,
        },
      },
      tags: ['open', 'page', 'link', 'navigate', 'go to', 'show'],
    }),
  );

  const seen = new Map();
  for (const c of capabilities) {
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(c.name)) problems.push(`${c.method} ${c.path}: tool name ${c.name} is not <module>.<verb_object>`);
    if (seen.has(c.name)) problems.push(`duplicate tool name ${c.name}: ${seen.get(c.name)} and ${c.method} ${c.path}; set @Capability({ name })`);
    seen.set(c.name, `${c.method} ${c.path}`);
    if (c.uiHref && !pages.includes(c.uiHref.replace(/:\w+/g, ':id'))) problems.push(`${c.name}: uiHref ${c.uiHref} is not an app page`);
  }
  if (problems.length && !lenient) {
    const err = new Error(`capabilities: ${problems.length} problem(s)\n  - ${problems.join('\n  - ')}`);
    err.problems = problems;
    throw err;
  }

  capabilities.sort((a, b) => a.name.localeCompare(b.name));
  excluded.sort((a, b) => a.route.localeCompare(b.route));
  return {
    $comment: 'Generated by `pnpm capabilities:generate` (scripts/capabilities). Do not edit; packages/internal-agent/test/capabilities.test.ts fails when stale.',
    version: 1,
    appRoutes: pages,
    capabilities,
    excluded,
    ...(lenient ? { problems } : {}),
  };
}

/** Stable text of the catalog file. */
export function serializeCatalog(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}
