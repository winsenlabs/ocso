# 04: Backend and frontend stack (NestJS 12, TypeScript 7, Next.js 16.3, Drizzle, zod, Vitest, OTel, pnpm/turbo)

Researched 2026-09-22 on Node 26.8.1 and pnpm 11.1.2. Versions come from the npm registry today.

**Method:** I built a throwaway monorepo at `/private/tmp/claude-501/research-stack/mono`: `packages/{domain,db}`, `apps/api` (Nest 12 HTTP app plus a worker context) and `apps/web` (Next 16.3). Against it I ran TS 7 builds, Vitest 5 unit and Testcontainers (Postgres 17) e2e tests, an OTel collector (`otelcol-contrib` 0.161.0, debug exporter), api and web Docker images run together, and Playwright against the standalone web server. Side probes cover `nest new`, `nest build`/`nest g` on TS 7, Kysely and Drizzle 1.0-rc.

Tags: **VERIFIED(run)** = I executed it. **VERIFIED(docs)** = docs or release notes fetched today. **UNVERIFIED** = inference.

## TL;DR: recommended toolchain

| Concern | Choice (pin exactly) | Why |
|---|---|---|
| TypeScript | **`typescript@7.0.2` everywhere** | Emits `experimentalDecorators` and `emitDecoratorMetadata` correctly, so Nest DI works (VERIFIED(run)). `next build` type-checks with it, and `--watch` works. |
| Nest build | **Plain `tsc -p tsconfig.build.json`**, no `nest build` | Nest CLI 12.0.3 needs the TS JS API, which TS 7.0 doesn't ship. `nest build` (tsc *and* swc) and `nest g` fail (VERIFIED(run)). |
| Nest runtime | `@nestjs/*@12.0.4`, ESM, Express 5.2.1 adapter | ESM-only packages. Legacy decorators plus `reflect-metadata` are still required. |
| ORM / migrations | **`drizzle-orm@0.45.3`** + **`drizzle-kit@0.31.11 generate`** for SQL files + **our own ~40-line runner** | Typed builder with `.for('update',{skipLocked:true})` and a `sql` escape hatch. SQL is committed. The 0.45 migrator silently skips out-of-order files, so we don't use it. |
| Validation | **Built-in `StandardSchemaValidationPipe` + `@Body({ schema })`**, zod 4.6.5 schemas in `@ocso/domain` | New in Nest 12. `nestjs-zod@5.5.0` peers only on Nest ^10/^11. |
| Tests | **Vitest 5.0.1 + Vite 8.3.0, no `unplugin-swc`**. Plus `@nestjs/testing`, supertest 7.2.2, `@testcontainers/postgresql@12.1.0`, `@playwright/test@1.63.0`. | Vite 8's Oxc honours `emitDecoratorMetadata` from tsconfig (VERIFIED(run)). |
| Lint | `oxlint` + `oxlint-tsgolint` (type-aware on TS 7) | typescript-eslint still needs the TS 6 API. `no-floating-promises` works (VERIFIED(run)). |
| Observability | `@opentelemetry/sdk-node@0.222.0` (SDK 2.11.0), OTLP/proto, `auto-instrumentations-node@0.80.0`, `nestjs-pino@5.2.0` + `pino@10.3.1` | Traces, metrics and logs arrived, and log lines carry `trace_id`. Nest spans need our own interceptor. |
| Web | `next@16.3.5`, `react@19.3.0`, Turbopack, `output:'standalone'`, `cacheComponents:true` | proxy.ts, SSE pass-through, server action and Docker image all VERIFIED(run). |
| Monorepo | `pnpm@11.1.2` (catalogs + `allowBuilds`), `turbo@2.11.2`. Docker: `turbo prune --docker` → build → `pnpm deploy --legacy` (api), standalone (web). | Both images ran together (VERIFIED(run)). |

## 1. NestJS 12 (12.0.4 = `latest`; v11 = `legacy` 11.2.5)

**Changes from v11** (VERIFIED(docs) plus package.json):
- **ESM and Node.**
  - Every `@nestjs/*` package is `"type":"module"`.
  - CJS apps can still load them through `require(esm)`, so moving the app itself to ESM is optional.
  - Node versions: the runtime needs **20.19+ / 22.12+ / 26+**; the CLI needs 22.22.3+ / 24.15+ / 26+.
- **Decorators.**
  - Still **legacy decorators**: `reflect-metadata` (peer `^0.1.12 || ^0.2.0`) and `emitDecoratorMetadata` are required.
  - TC39 standard decorators don't compile: `@Param()` gives TS1206 "Decorators are not valid here" (VERIFIED(run)).
- **HTTP adapters.** `platform-express@12.0.4` pins **express 5.2.1** (path-to-regexp 8; catch-alls log as `{/*splat}`). `platform-fastify@12.0.4` pins **fastify 5.12.5**. Express apps now drain in-flight requests on shutdown.
- **Validation.** `@Body/@Query/@Param/@RawBody` take `{ schema }` (`@Headers` does not). New `StandardSchemaValidationPipe` and `StandardSchemaSerializerInterceptor`. `@nestjs/config@12` accepts any Standard Schema; Joi options move under `libraryOptions`.
- **Other breaks:** `@Optional()` is not inherited; lifecycle hooks run in module-hierarchy order; NATS → `@nats-io/transport-node`; GraphQL → graphql-ws + GraphiQL; Terminus drops `HealthCheckError`; Rspack replaces webpack for Nest-CLI monorepos.
- **`nest new` template** (VERIFIED(run)): ESM, `typescript ^6.0.2`, **vitest ^4.1.2** (not 5), oxlint + tsgolint, `@nestjs/mau` (their deploy SaaS). tsconfig: `nodenext` + `experimentalDecorators` + `emitDecoratorMetadata` + `isolatedModules`.
- **`@nestjs/observe` 0.3.1** (the `--observe` option) is a **SaaS agent** (observe.nestjs.com app key/secret), not OTel. Skip it.

**`apps/api/tsconfig.json`**
- It extends OCSO's base (`nodenext`, es2024, strict, isolatedModules).
- It also compiles clean with OCSO's `exactOptionalPropertyTypes` and `noImplicitOverride` (VERIFIED(run)).
- `tsconfig.build.json` extends it with `rootDir: "src"` and `types: ["node"]`, and excludes `**/*.spec.ts`.

```jsonc
{ "extends": "../../tsconfig.base.json",
  "compilerOptions": { "experimentalDecorators": true, "emitDecoratorMetadata": true,
    "rootDir": ".", "outDir": "dist", "declaration": false, "types": ["node", "vitest/globals"] },
  "include": ["src", "test"] }
```

Scripts:
- Build: `tsc -p tsconfig.build.json`.
- Dev: `tsc -p tsconfig.build.json --watch & node --watch --import ./dist/instrumentation.js dist/main.js`.

Relative imports use `./x.js`.

**Gotcha:** under `isolatedModules`, a constructor parameter typed through `import type { Foo }` gets emitted as `Object`, and DI breaks. Import injectables as values, or use `@Inject(TOKEN)`.

**Bootstrap, webhook raw body, SSE** (VERIFIED(run)): a bad body returns 400 `["agentId: Invalid UUID", …]`; `"priority":"7"` is coerced to 7; the HMAC check over the raw bytes returns 202/401; SSE responses carry `text/event-stream` and `x-accel-buffering: no`.

```ts
const app = await NestFactory.create(AppModule, { rawBody: true, bufferLogs: true });
app.useLogger(app.get(Logger));                          // nestjs-pino
app.useGlobalPipes(new StandardSchemaValidationPipe());  // @nestjs/common
app.enableShutdownHooks();
await app.listen(Number(process.env.PORT ?? 4000), '0.0.0.0');

@Post('runs') create(@Body({ schema: CreateRunInput }) body: CreateRunInputT) { … }
@Get('runs/:id') get(@Param('id', { schema: z.uuid() }) id: string) { … }
@Post('webhooks/github') @HttpCode(202)
webhook(@RawBody() raw: Buffer | undefined, @Headers('x-hub-signature-256') sig?: string) { /* createHmac(raw) + timingSafeEqual */ }
@Sse('runs/:id/events')          // @SseSignal() (new in 12) aborts on client disconnect or stream end
events(@Param('id') id: string, @SseSignal() signal: AbortSignal): Observable<MessageEvent> { … }
```

**Worker = standalone application context.** It gives DI and lifecycle hooks with no HTTP listener. VERIFIED(run): it claimed a run via SKIP LOCKED, recorded metrics and exited cleanly.
```ts
const ctx = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
ctx.useLogger(ctx.get(Logger));
ctx.enableShutdownHooks(['SIGTERM', 'SIGINT']);  // loop starts in onApplicationBootstrap, drains in onApplicationShutdown
```

## 2. TypeScript 7.0 (7.0.2, GA July 2026)

| Check | Result |
|---|---|
| `tsc` 7 with `experimentalDecorators` + `emitDecoratorMetadata` | Works: emits `__metadata("design:paramtypes",[GreetService])`, and Nest DI resolves at runtime. `--watch` works. VERIFIED(run) |
| `nest build` (tsc builder) and `nest build -b swc` | Both fail, exit 1: "does not expose the programmatic compiler API … install TypeScript 6". VERIFIED(run) |
| `nest generate service x` | Fails: `'typescript' does not provide an export named 'SyntaxKind'`. VERIFIED(run) |
| Side-by-side workaround | `"typescript": "npm:@typescript/typescript6@^6.0.2"` plus `"@typescript/native": "npm:typescript@^7.0.2"`. `nest build` (tsc/swc) then works; `tsc` resolves to 7, `tsc6` to 6. VERIFIED(run) |
| `nest build -b swc` in an ESM project | Emits **CJS** unless `.swcrc` sets `module.type: "es6"`. Otherwise you get `ERR_AMBIGUOUS_MODULE_SYNTAX`. VERIFIED(run) |
| `next build` 16.3.5 with TS 7 | Works: it runs the project-local `tsc` CLI (`useTypeScriptCli` default), and a type error fails the build. VERIFIED(run) |
| Removed in 7.0 | `target es5`, `downlevelIteration`, `moduleResolution node/node10/classic`, `baseUrl`, `module amd/umd/systemjs/none`. `esModuleInterop` can't be false. No JS API until 7.1, which rules out ts-jest, ts-node, ts-loader, typescript-eslint and the Nest swagger/graphql CLI plugins. VERIFIED(docs) |

**Decision: TS 7 only.** Losing the Nest CLI is acceptable: generators are trivial to hand-write, we don't use the swagger compile-time plugin, and lint moves to oxlint. If the swagger plugin ever becomes necessary, add the TS 6 alias to `apps/api` alone.

## 3. Next.js 16.3 (16.3.5, React 19.3.0)

**Breaking changes from 15** (VERIFIED(docs), v16 upgrade guide):
- **Turbopack** is the default for dev and build. A custom `webpack` config fails the build unless you pass `--webpack`. `experimental.turbopack` moves to top-level `turbopack`.
- **Request APIs are async only:** `cookies()/headers()/draftMode()/params/searchParams`. Use `PageProps<'/x/[id]'>` / `RouteContext<…>` from `next typegen`.
- **`middleware.ts` → `proxy.ts`**, with the export named `proxy`. It always runs on the Node runtime; edge isn't allowed.
- **Caching:**
  - `revalidateTag(tag, profile)` now needs the second argument.
  - New `updateTag` (read-your-writes in server actions) and `refresh()`.
  - `cacheLife`/`cacheTag` are stable.
  - PPR, `dynamicIO` and `useCache` flags are replaced by top-level **`cacheComponents: true`**.
- **React Compiler:** `reactCompiler: true` is stable, but off by default (Babel).
- **Removed:** `next lint`, AMP, `serverRuntimeConfig/publicRuntimeConfig`. Parallel-route slots now need `default.js`. `next/image` defaults changed (qualities `[75]`, 4 h TTL, local-IP block).
- **Minimums:** Node ≥ 20.9, TS ≥ 5.1.

**New in 16.3** (VERIFIED(docs)): Turbopack FS cache on for build; up to 90% less dev memory; native Node streams (up to 22% more SSR throughput); `partialPrefetching`, `catchError`, `next/root-params`, `import.meta.glob`, `@next/playwright` `instant()`. Experimental: `turbopackRustReactCompiler`, `useOffline`. `next dev` maintains an `AGENTS.md` block pointing at `node_modules/next/dist/docs/`.

**Calling the Nest API** (VERIFIED(run), with `cacheComponents:true`): the page built as `◐ Partial Prerender` with the dynamic list streamed inside `<Suspense>`; with no cookie, proxy.ts returned 307 to `/login`; SSE came through the route handler intact.

```ts
// lib/api.ts ('server-only'). API_URL = internal service URL, never NEXT_PUBLIC_*
export async function api(path: string, init: RequestInit = {}) {
  const session = (await cookies()).get('ocso_session')?.value;
  const headers = new Headers(init.headers);
  if (session) headers.set('authorization', `Bearer ${session}`);
  return fetch(`${process.env.API_URL}${path}`, { ...init, headers, cache: 'no-store', signal: init.signal ?? AbortSignal.timeout(10_000) });
}
// app/api/runs/[id]/events/route.ts: same-origin, cookie-authenticated SSE for the browser
export async function GET(req: Request, ctx: RouteContext<'/api/runs/[id]/events'>) {
  const { id } = await ctx.params;
  const up = await api(`/runs/${encodeURIComponent(id)}/events`, { headers: { accept: 'text/event-stream' }, signal: req.signal });
  return new Response(up.body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } });
}
// proxy.ts: optimistic cookie-presence redirect only; Nest authorizes every call (docs: "Do not rely on proxy alone")
export function proxy(req: NextRequest) { if (!req.cookies.has('ocso_session')) return NextResponse.redirect(new URL('/login', req.url)); }
export const config = { matcher: ['/((?!login|_next/static|_next/image|favicon.ico).*)'] };
```

Rules:
- Server Components call the API directly. They don't go through their own route handlers (docs caveat).
- Mutations are server actions. Each one `safeParse`s with the shared zod schema, calls the API, then calls `refresh()` or `updateTag()`.
- The session cookie is `httpOnly; Secure; SameSite=Lax`, set by a route handler after login. The browser never holds the API token.
- With `cacheComponents` on, every dynamic read (`cookies()`) must sit under `<Suspense>`.

**Standalone output** (VERIFIED(run)): `{ output: 'standalone', outputFileTracingRoot: path.join(import.meta.dirname, '../../') }` produces `.next/standalone/apps/web/server.js` plus traced node_modules (42 MB; workspace packages are bundled). Copy `.next/static` (and `public`) into `standalone/apps/web/`, then start with `HOSTNAME=0.0.0.0 PORT=3000 node apps/web/server.js`. `next build` rewrites tsconfig (adds `.next/dev/types/**/*.ts`, forces `esModuleInterop: true`); commit that change.

## 4. ORM and migrations

| | Migrations | Types / runtime | `FOR UPDATE SKIP LOCKED` | Status / risk |
|---|---|---|---|---|
| **Drizzle 0.45.3** (stable) | TS schema → `drizzle-kit generate` → `.sql` (committed); `--custom` for hand SQL | Inferred from the TS schema; no codegen, no engine | `.for('update',{skipLocked:true})` VERIFIED(run) | The **migrator skips any file older than the last applied timestamp** (`pg-core/dialect.js`). It has no lock and no checksum check. kit 0.31.11 only adds a warning. |
| Drizzle 1.0.0-rc.4 (Jun 27; still `rc`) | One folder per migration plus `drizzle-kit check` for branch conflicts | Same, plus JIT mappers; RQB v2 `defineRelations` VERIFIED(run) | same | Pre-release after 5 months of RCs. The migrator now applies by **name** (fixed). |
| Kysely 0.29.6 (+ kysely-codegen 0.20 / kysely-ctl 0.21) | TS up/down files, or bring your own SQL runner | DB interface, hand-written or introspected | `.forUpdate().skipLocked()` VERIFIED(run) | Stable, but the most hand-work (schema written twice). |
| Prisma 7.10 client (CLI `latest` = 8.0.0-rc.15!) | `migrate dev/deploy`, SQL committed | Build-time generated client, mandatory `@prisma/adapter-pg`, ESM, `prisma.config.ts` | Only via `$queryRaw`/TypedSQL | `npm i prisma` installs an RC today. Heaviest option. VERIFIED(docs) |

**Recommendation: Drizzle 0.45.3 + drizzle-kit 0.31.11, with our own migration runner.**

It meets every requirement: reviewed, committed SQL migrations; a typed queue-claim query and a typed `sql` escape hatch; nothing generated at runtime; a normal workspace package. Pin it **exactly** via `catalog:` so api and db share one drizzle instance. drizzle-kit 0.31 loaded an ESM schema with `./x.js` imports without trouble (VERIFIED(run)).

**The runner (`packages/db/src/migrate.ts`, ~40 lines)** applies `migrations/*.sql` sorted by **filename**, skips files already in `public.schema_migrations(name, checksum)`, runs each file in its own transaction (split on `--> statement-breakpoint`) under `pg_advisory_lock(hashtext('ocso:migrations'))`, and refuses to run if an applied file was edited. VERIFIED(run): a second run is a no-op, two concurrent runs apply each file once, and an edited file is rejected.

Run it as its own deploy task (`node dist/migrate.js`) before rolling the api and worker. Never run it from app boot.

**Stay off RQB v1** (`db.query.*` + `relations()`) and use the core builder. Then moving to 1.0 means converting the migrations folder, not rewriting queries. Revisit when 1.0 hits `latest`.

```ts
// VERIFIED: 20 queued rows, 30 concurrent claimers → no run claimed twice
export async function claimNextRun(db: Db, workerId: string) {
  return db.transaction(async (tx) => {
    const [next] = await tx.select({ id: runs.id }).from(runs).where(eq(runs.status, 'queued'))
      .orderBy(desc(runs.priority), asc(runs.createdAt)).limit(1).for('update', { skipLocked: true });
    if (!next) return null;
    const [claimed] = await tx.update(runs).set({ status: 'running', lockedBy: workerId, updatedAt: sql`now()` })
      .where(and(eq(runs.id, next.id), eq(runs.status, 'queued'))).returning();
    return claimed ?? null;
  });
}
// drizzle.config.ts: { dialect:'postgresql', schema:'./src/schema/index.ts', out:'./migrations', casing:'snake_case', strict:true }
// runtime: drizzle({ client: pool, schema, casing: 'snake_case' })  (casing must match the kit config)
```

## 5. Validation (zod 4.6.5)

- **Use Nest 12's built-in Standard Schema support** (VERIFIED(run)); zod 4 implements `~standard`. Register `app.useGlobalPipes(new StandardSchemaValidationPipe())` and add `{ schema }` per parameter. `transform` defaults to true, so coerced and defaulted values reach the handler; errors come back as `"path: message"` strings. Options: `exceptionFactory(issues)`, `validateCustomDecorators`, `errorHttpStatusCode`. For responses, use `StandardSchemaSerializerInterceptor`.
- **`nestjs-zod@5.5.0`** (Jul 2026) peers on `@nestjs/common ^10 || ^11`. It isn't needed, and neither is a custom pipe.
- **Shared schemas live in `@ocso/domain`:** `const CreateRunInput = z.object(…)`, with `z.infer<…>` as the output type and `z.input<…>` as the form input. The web server action and the Nest pipe use the same object (VERIFIED(run)). Parameter types are aliases, so the emitted metadata is `Object`; that's harmless because the pipe reads `metadata.schema`.

## 6. Testing

**Vitest 5.0.1:**
- `vite` is a **peer dependency**; install `vite@8.3.0` yourself. Node ^22.12, ^24 or ≥26. Mocks are now cleared before each test by default; the `*.sequential` options are gone; `vite-tsconfig-paths` is redundant (`resolve.tsconfigPaths: true`).
- **No `unplugin-swc` is needed.** Vite 8 (rolldown/Oxc) reads `experimentalDecorators` and `emitDecoratorMetadata` from the nearest tsconfig. VERIFIED(run): `Reflect.getMetadata('design:paramtypes', AppController)` equals `[AppService]`, and deleting the flag breaks DI. Keep the flags in each Nest package's own tsconfig.

**Testcontainers 12.1.0** (VERIFIED(run), about 9 s including container start): `new PostgreSqlContainer('postgres:17-alpine').start()` → migrate → `Test.createTestingModule({ imports: [AppModule] }).compile()` → `createNestApplication({ rawBody: true })` → `useGlobalPipes(…)` → `init()` → `supertest(app.getHttpServer())` for HTTP and SSE. These go in OCSO's `integration` project (`pool:'forks'`, `fileParallelism:false`). **Colima needs** `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock` and `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`; otherwise you get "Could not find a working container runtime strategy".

**Playwright 1.63.0** (VERIFIED(run)): `baseURL` points at the standalone server, `context.addCookies` sets the session, and both tests (proxy redirect, list streamed from the API) passed. `@next/playwright@16.3.5` `instant()` asserts the prefetched shell (VERIFIED(docs)). Side effect: `playwright install` garbage-collects other Playwright versions' browsers in `~/Library/Caches/ms-playwright`.

## 7. OpenTelemetry (Node 26, ESM)

Versions: `sdk-node`/`exporter-*`/`sdk-logs`/`instrumentation` 0.222.0; `sdk-metrics`/`resources`/`sdk-trace-node` 2.11.0; `api` 1.9.1; `semantic-conventions` 1.43.0; `auto-instrumentations-node` 0.80.0; `import-in-the-middle` 3.5.1. Since 0.221, only **stable HTTP semconv** is emitted (`http.server.request.duration`).

```ts
// src/instrumentation.ts; run: node --import ./dist/instrumentation.js dist/main.js  (worker: dist/worker.js)
import { register as registerEsmHooks } from 'import-in-the-middle/register-hooks.mjs'; // direct dep + 4-line .d.ts shim (no exports map)
registerEsmHooks();  // sync module.registerHooks() (Node ≥22.22.3/24.11.1/26); avoids Node 26's module.register() deprecation
const sdk = new NodeSDK({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'ocso-api', [ATTR_SERVICE_VERSION]: process.env.APP_VERSION }),
  traceExporter: new OTLPTraceExporter(),   // *-otlp-proto; OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318
  metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 15_000 })],
  logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],  // options-object ctor since 0.220
  instrumentations: [getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-fs': { enabled: false }, '@opentelemetry/instrumentation-dns': { enabled: false },
    '@opentelemetry/instrumentation-net': { enabled: false }, '@opentelemetry/instrumentation-router': { enabled: false },
    '@opentelemetry/instrumentation-http': { ignoreIncomingRequestHook: (r) => r.url === '/healthz' } })],
});
sdk.start();
(globalThis as any).__otelSdk = sdk;   // flushed from Nest; see gotcha 3
```

**What the collector received** (VERIFIED(run)):
- **Spans:** `POST /runs`, express handler spans, `pg-pool.connect`, `pg.query:INSERT ocso`, and our `RunsController.create` with pg as its child.
- **Metrics:** `http.server.request.duration`, `db.client.operation.duration` plus pool gauges, `nodejs.eventloop.*`, `v8js.*`, and our custom `ocso.runs.claimed` (counter) and `ocso.agent.turn.duration` (histogram).
- **Logs:** the pino records.

**Gotchas** (VERIFIED(run)):
1. **`instrumentation-nestjs-core@0.68.0` supports `>=4 <12`**, so Nest 12 emits no Nest spans. Add a ~20-line global `APP_INTERCEPTOR` that wraps `next.handle()` in `tracer.startActiveSpan(\`${Class}.${handler}\`)`. Express, pg and pino are CJS, so require-in-the-middle patches them either way; the ESM hook only matters for future ESM-only libraries.
2. **Log correlation needs no config.** With `nestjs-pino@5.2.0` (peers Nest ^11.0.8 || ^12.0.2, pino ^10, pino-http ^11) and auto `instrumentation-pino`, every JSON line gets `trace_id`, `span_id` and `trace_flags`, and records are also forwarded over OTLP.
3. **Shutdown flush.** `process.once('SIGTERM', () => sdk.shutdown())` inside the instrumentation file loses traces: Nest's `enableShutdownHooks()` re-raises the signal after `app.close()`, killing the process before the 5 s batch flush. Use a provider instead: `class OtelFlush implements OnApplicationShutdown { onApplicationShutdown() { return globalThis.__otelSdk?.shutdown(); } }`. With it, spans arrived even on an immediate SIGTERM.
4. **Disable `instrumentation-router`.** Express 5's `router` package otherwise emits "middleware - patched" noise spans.
5. **Load via `--import`, not from `main.ts`**, so the hooks exist before `pg`/`express` load.

**Custom metrics:** `metrics.getMeter('ocso-api').createHistogram('ocso.agent.turn.duration', { unit: 's', advice: { explicitBucketBoundaries: [0.1,0.5,1,2,5,10,30,60,120] } })`, plus `createCounter(…)`. Attributes must be low-cardinality (`outcome`, `provider`, `model`), never IDs.

**AWS CloudWatch** (VERIFIED(docs)): the app always exports OTLP/HTTP to a collector. On ECS, run an **ADOT or `otelcol-contrib` sidecar** with the `sigv4auth` extension and three `otlphttp` exporters:
- traces → `https://xray.<region>.amazonaws.com/v1/traces` (UNVERIFIED: needs X-Ray Transaction Search enabled)
- logs → `https://logs.<region>.amazonaws.com/v1/logs`, with headers `x-aws-log-group` and `x-aws-log-stream`
- metrics → `https://monitoring.<region>.amazonaws.com/v1/metrics`

These endpoints are HTTP only (no gRPC), gzip or no compression; metrics allow ≤1,000 datapoints/request and ≤150 labels. In Compose, the same app config points at a local collector.

## 8. pnpm 11 + turbo 2.11

```yaml
# pnpm-workspace.yaml: all non-auth settings live here; .npmrc is auth/registry only in pnpm 11
catalog:             # exact pins for single-instance deps: typescript, @nestjs/*, drizzle-orm, zod
  typescript: 7.0.2
  "@nestjs/common": 12.0.4
  drizzle-orm: 0.45.3
allowBuilds:         # replaces onlyBuiltDependencies/neverBuiltDependencies (removed)
  esbuild: true      # drizzle-kit
  sharp: true        # next/image
  "@swc/core": true
  protobufjs: false  # OTel exporters; postinstall is only a version check
  ssh2: false        # testcontainers → docker-modem (optional native)
  cpu-features: false
```

**Gotchas** (VERIFIED(run) unless marked):
- **`strictDepBuilds` is on.** An unapproved postinstall fails with `ERR_PNPM_IGNORED_BUILDS`, and pnpm appends `'pkg': set this to true or false` placeholder lines to `allowBuilds`. Edit them in place: appending your own keys causes `duplicated mapping key` on the next install.
- **`minimumReleaseAge` defaults to 1 day.** `drizzle-orm@^0.45.0` resolved to 0.45.2 because 0.45.3 was only 22 h old, and oxlint resolved to 1.83, not 1.85. Exact pins bypass the rule.
- **Strict isolation.** `apps/api` had to declare `drizzle-orm`, `pg`, `@types/pg` and `import-in-the-middle` itself. Use `workspace:*` for internal packages and `catalog:` for shared versions.
- **`pnpm deploy` fails** with `ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE` unless `injectWorkspacePackages: true` is set, and that setting makes dev use copies instead of symlinks. Use **`pnpm deploy --legacy`** in Docker only. The output is `dist/` plus `node_modules/@ocso/{db,domain}`, limited by each package's `files`, so `apps/api` needs `"files": ["dist"]`.
- **Other pnpm 11 changes** (VERIFIED(docs)): Node ≥ 22; env vars are `pnpm_config_*` (not `npm_config_*`); `verifyDepsBeforeRun: install`; new `pnpm ci`, `pnpm peers check`, `pnpm sbom`.
- **Node 26 images have no corepack**; use `npm i -g pnpm@11.1.2`.
- **`turbo prune --docker`** keeps `catalog` and `allowBuilds`. It **drops root files** like `tsconfig.base.json`: copy them explicitly, or move shared tsconfig into an `@ocso/tsconfig` package.
- **turbo.json:** `build.dependsOn: ["^build"]`, `outputs: ["dist/**", ".next/**", "!.next/cache/**"]`.

**Dockerfile** (one file, two targets). Both images were built and ran together, web → api → Postgres (VERIFIED(run)). Image sizes: api 508 MB (node_modules 115 MB), web 429 MB.
```dockerfile
FROM node:26-slim AS base
ENV CI=true PNPM_HOME=/pnpm PATH=/pnpm:$PATH TURBO_TELEMETRY_DISABLED=1
RUN npm i -g pnpm@11.1.2 turbo@2.11.2

FROM base AS prune
ARG APP
WORKDIR /repo
COPY . .
RUN turbo prune ${APP} --docker

FROM base AS build
ARG APP
WORKDIR /repo
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ .
COPY tsconfig.base.json ./
RUN turbo run build --filter=${APP}...
# only the api/worker target uses /out
RUN pnpm deploy --legacy --filter=${APP} --prod /out

FROM node:26-slim AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /out .
USER node
CMD ["node", "--enable-source-maps", "--import", "./dist/instrumentation.js", "dist/main.js"]

FROM node:26-slim AS web
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
CMD ["node", "apps/web/server.js"]
```

- **Build:** `docker build --build-arg APP=@ocso/api --target api .` (web: `--build-arg APP=@ocso/web --target web`).
- **Worker:** same image as api; override CMD with `dist/worker.js`.
- **Migrations:** a separate task built with `pnpm deploy --legacy --filter=@ocso/db --prod /out`, running `node dist/migrate.js`. `@ocso/db` ships `files: ["dist","migrations"]`.
- **Cache mounts need BuildKit.** This Colima has no buildx, so I tested with `--mount` stripped.
- UNVERIFIED: whether an alpine or distroless base shrinks the images meaningfully.

## Sources
- [NestJS migration guide (v12)](https://docs.nestjs.com/migration-guide) · [Nest v12.0.0 release](https://github.com/nestjs/nest/releases/tag/v12.0.0) · [Trilon: NestJS 12](https://trilon.io/blog/nestjs-12-is-now-available) · [Nest SWC recipe](https://docs.nestjs.com/recipes/swc)
- [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) · [NestJS + TS 7 notes](https://fernforge.github.io/devnotes/nestjs-typescript-7/)
- [Next.js 16 upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-16) · [Next.js 16.3](https://nextjs.org/blog/next-16-3) · [BFF guide](https://nextjs.org/docs/app/guides/backend-for-frontend) · [output: standalone](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)
- [Drizzle v0→v1 changes](https://orm.drizzle.team/docs/v0-v1-changes) · [Drizzle releases](https://github.com/drizzle-team/drizzle-orm/releases) · [Prisma 7 upgrade guide](https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-7)
- [Vitest 5](https://vitest.dev/blog/vitest-5.html) · [OTel JS ESM support](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/esm-support.md) · [OTel experimental CHANGELOG](https://github.com/open-telemetry/opentelemetry-js/blob/main/experimental/CHANGELOG.md) · [CloudWatch OTLP endpoints](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLPEndpoint.html)
- [pnpm 11.0](https://pnpm.io/blog/releases/11.0) · [pnpm deploy](https://pnpm.io/cli/deploy) · [pnpm 10→11 Docker/CI pitfalls](https://dev.classmethod.jp/en/articles/pnpm-v10-to-v11-migration-docker-ci/)
