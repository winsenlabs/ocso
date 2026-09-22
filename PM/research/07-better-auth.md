# 07: Better Auth 1.7 for OCSO authentication

Researched 2026-09-22. **Method:** no packages installed, no code run. I sparse-cloned `github.com/better-auth/better-auth` at tag `v1.7.5` into a scratch dir and read the docs MDX (`docs/content/docs/**`, which is what better-auth.com renders; one live page spot-checked and identical), the release/security blog posts, and the source of `packages/{core,better-auth,drizzle-adapter,sso,passkey,cli}/src`; plus npm registry metadata, `better-call@1.4.0` compiled JS (signed-cookie format) and `gh api repos/better-auth/better-auth/security-advisories`.

**Source tags** expand to URLs: `[D:x]` = https://www.better-auth.com/docs/x · `[B:x]` = https://www.better-auth.com/blog/x · `[S:x]` = https://github.com/better-auth/better-auth/blob/v1.7.5/packages/x · `[GHSA-…]` = https://github.com/better-auth/better-auth/security/advisories/GHSA-… . **Confidence:** **SRC** = confirmed in v1.7.5 source; **DOCS** = docs only; **UNVERIFIED** = sources conflict or unclear, confirm against the installed package.

## TL;DR

- **Versions and packaging.** `better-auth@1.7.5` is `latest` (2026-09-14). 1.7.0 went GA on 2026-08-18. `release-1.6` is 1.6.33. All packages are ESM-only. `better-auth` pins `@better-auth/drizzle-adapter@1.7.5`, so `better-auth/adapters/drizzle` still works. The CLI is the npm package **`auth`** (bins `auth` and `better-auth`, Node ≥22.12). `@better-auth/cli` is frozen at 1.4.x.
- **The rate limiter reads the client IP only from headers.** By default that is `x-forwarded-for`, and only when it holds a single value. It never reads the socket, and `toNodeHandler` does not add it. In production with no trusted header, everyone shares one bucket per path: `/sign-in/email` becomes **3 requests per 10 s for the whole site**. SRC `[S:better-auth/src/api/rate-limiter/index.ts]`
- **`auth.api.*` skips HTTP-only checks.** `disabledPaths` and rate limits apply only to HTTP requests through `auth.handler`. `auth.api.*` calls bypass both, but global and plugin `hooks` still run on them. SRC `[S:better-auth/src/api/index.ts]`
- **Sign-up can't be done server-side when disabled.** `auth.api.signUpEmail` throws `EMAIL_PASSWORD_SIGN_UP_DISABLED` when `disableSignUp:true`, even from the server. To create users anyway, use admin `auth.api.createUser` (a call without headers is trusted) or `internalAdapter.createUser(user, source)`.
- **2FA gaps.** Only `/sign-in/email`, `/sign-in/username` and `/sign-in/phone-number` get a 2FA challenge. **Passkey and SSO sign-ins skip it.** There is **no option to enforce 2FA**. Users without a password can enroll only with `allowPasswordless:true`.
- **SSO defaults.** Any signed-in user can register **up to 10 providers** (`providersLimit`), and registering needs a session even via `auth.api`. SSO providers never inherit `trustedProviders`. The OIDC `clientSecret` is stored **unencrypted**. Discovered IdP URLs must be listed in `trustedOrigins`. IdP-initiated SAML is **off**.
- **CSRF.** A non-GET request **that carries a Cookie** must send a trusted `Origin` or `Referer`, else 403 `MISSING_OR_NULL_ORIGIN`. Requests with no cookie and no Origin pass. SRC `[S:better-auth/src/api/middlewares/origin-check.ts]`
- **Fresh-session endpoints.** `listSessions`, `unlinkAccount` and passkey registration need a session whose `createdAt` is within `freshAge` (default 1 day). Otherwise they return 403 `SESSION_NOT_FRESH`. SRC `[S:better-auth/src/api/routes/session.ts]`
- **UUID ids.** With `generateId:"uuid"` on Drizzle `pg`, Better Auth **omits `id`** from inserts and relies on the database default `gen_random_uuid()`, which the CLI emits. SRC `[S:core/src/db/adapter/get-id-field.ts]`
- **Advisories.** No published advisory lists a 1.7.x GA version as affected. The newest, GHSA-8c5h-wx78-2cfg (2026-08-11), is fixed in sso 1.7.0-rc.5.

## 1. Core options

```ts
betterAuth({
  appName: "OCSO",                        // default "Better Auth"; env APP_NAME; default 2FA TOTP issuer
  baseURL: "https://app.example.com",     // string | { allowedHosts: string[], protocol?: "http"|"https"|"auto", fallback?: string }
  basePath: "/api/auth",                  // default; a path inside baseURL wins
  secret: process.env.BETTER_AUTH_SECRET, // else env BETTER_AUTH_SECRET, then AUTH_SECRET
  secrets: [{ version: 2, value: "…" }, { version: 1, value: "…" }], // or env BETTER_AUTH_SECRETS="2:…,1:…"
  trustedOrigins: ["https://app.example.com"], // string[] | (request?: Request) => Awaitable<(string|null|undefined)[]>
  telemetry: { enabled: false, debug: false }, // default OFF; env BETTER_AUTH_TELEMETRY=0|1
  logger: { disabled: false, disableColors: false, level: "warn", log: (level, message, ...args) => {} },
  experimental: { instrumentation: { enabled: true } }, // OTel spans, default on (1.7.4)
});
```

- **`baseURL`.** Resolution order: the explicit value, then `BETTER_AUTH_URL`, then inference from the request (with a warning). With the dynamic form, forwarded headers are ignored unless `advanced.trustedProxyHeaders:true`. Without a `fallback`, unknown hosts throw. `[D:reference/options]`
- **Secret validation** (SRC `[S:better-auth/src/context/create-context.ts]`): The built-in default secret throws only when `NODE_ENV=production`. An empty secret throws. Fewer than 32 characters, or estimated entropy (`log2(unique^len)`) under 120 bits, only logs a warning. Generate one with `npx auth secret` or `openssl rand -base64 32`.
- **`secrets` (1.5).** The first entry encrypts; the others only decrypt. That covers TOTP secrets, OTPs, JWE caches, and OAuth tokens when `encryptOAuthTokens` is on. **UNVERIFIED:** signed cookies (`session_token`, `dont_remember`, `two_factor`, `trust_device`) are verified only with `ctx.context.secret`, the **current** key (SRC `[S:better-auth/src/api/routes/session.ts]`). So rotating keys probably signs everyone out, even though `[D:concepts/cookies]` says the previous keys stay valid "where supported".
- **`trustedOrigins`.** The `baseURL` origin is always trusted, and `BETTER_AUTH_TRUSTED_ORIGINS` (a comma-separated list) is appended. Wildcards: `*` does not cross `/`, `**` does, and `?` matches one character. For http(s) the pattern is matched against the origin only. A function receives `undefined` at init and on `auth.api` calls. SRC `[S:better-auth/src/context/helpers.ts]`

## 2. `emailAndPassword`, `emailVerification`, `session`, `user`, `account`, `verification`

Defaults are shown. Types come from SRC `[S:core/src/types/init-options.ts]`.

```ts
emailAndPassword: { enabled: false, disableSignUp: false, requireEmailVerification: false, minPasswordLength: 8, maxPasswordLength: 128,
  autoSignIn: true, password: { hash: async (pw) => string, verify: async ({ hash, password }) => boolean }, // default scrypt (non-blocking since 1.6)
  sendResetPassword: async ({ user, url, token }, request?) => {}, resetPasswordTokenExpiresIn: 3600,
  revokeSessionsOnPasswordReset: false, onPasswordReset: async ({ user }, request?) => {}, onExistingUserSignUp, customSyntheticUser },
emailVerification: { sendVerificationEmail: async ({ user, url, token }, request?) => {}, sendOnSignUp: undefined /* follows requireEmailVerification */,
  sendOnSignIn: false, autoSignInAfterVerification: false, expiresIn: 3600, beforeEmailVerification, afterEmailVerification },
session: { modelName: "session", fields: {}, additionalFields: {}, expiresIn: 604800, updateAge: 86400, freshAge: 86400 /* from createdAt since 1.6 */,
  disableSessionRefresh: false, deferSessionRefresh: false, storeSessionInDatabase: false, preserveSessionInDatabase: false, // latter two: secondaryStorage only
  cookieCache: { enabled: false, maxAge: 300, strategy: "compact" /*|"jwt"|"jwe"*/, refreshCache: false, version: "1" } },
user: { modelName: "user", fields: {}, additionalFields: { role: { type: "string", required: false, defaultValue: "member", input: false, returned: true } },
  validateUserInfo: async ({ user, source }, ctx) => void | { error, errorDescription? },   // 1.7: gate create-user / link-account / sign-in
  changeEmail: { enabled: false, sendChangeEmailConfirmation, updateEmailWithoutVerification: false },
  deleteUser: { enabled: false, sendDeleteAccountVerification, beforeDelete, afterDelete, deleteTokenExpiresIn: 86400 } },
account: { modelName: "account", fields: {}, encryptOAuthTokens: false, updateAccountOnSignIn: true,
  accountLinking: { enabled: true, disableImplicitLinking: false, trustedProviders: [] /* or async (req?) => [], may include "email-password" */,
    allowDifferentEmails: false, allowUnlinkingAll: false, updateUserInfoOnLink: false, requireLocalEmailVerified: true /* deprecated */ } },
verification: { modelName: "verification", fields: {}, disableCleanup: false, storeIdentifier: "plain" /*|"hashed"|{default,overrides}*/, storeInDatabase: false },
```

- **Email checks.** With `requireEmailVerification`, sign-in returns 403 `EMAIL_NOT_VERIFIED`. Signing up with an existing email returns 422 by default. Enumeration protection applies only with `requireEmailVerification` or `autoSignIn:false`. `[D:authentication/email-password]`
- **`additionalFields` flags.** `input:false` blocks both API input and `mapProfileToUser`, but `defaultValue` still applies (in JS only; the column is nullable). `returned` controls whether the field appears in responses. Renaming via `fields` keeps the original names for type inference. `[D:concepts/database]`
- **Core tables** `[D:concepts/database]`: `user` (id, name, email unique, emailVerified, image?, createdAt, updatedAt); `session` (id, userId FK cascade, token unique, expiresAt, ipAddress?, userAgent?, timestamps); `account` (id, userId, accountId, providerId, access/refresh tokens + expiries, scope?, idToken?, password?, timestamps); `verification` (id, identifier, value, expiresAt, timestamps).
- **Password accounts.** A password lives in an account row with `providerId:"credential"` and `accountId = user.id`. 1.7.3 removed the `account.issuer` column that 1.7.0–1.7.2 had added, so the schema is back to 1.6's. `[D:guides/1-7-upgrade-guide]`

## 3. `advanced`, IDs, CSRF

```ts
advanced: { cookiePrefix: "better-auth", useSecureCookies: undefined, defaultCookieAttributes: {},
  cookies: { session_token: { name: "ocso_session", attributes: { sameSite: "strict" } } },   // per-cookie override, keyed by base name
  crossSubDomainCookies: { enabled: false, domain: "example.com", additionalCookies: [] },
  ipAddress: { ipAddressHeaders: ["x-forwarded-for"], trustedProxies: [], ipv6Subnet: 64, disableIpTracking: false },
  trustedProxyHeaders: false, disableCSRFCheck: false, disableOriginCheck: false, skipTrailingSlashes: false, backgroundTasks: { handler },
  database: { generateId: undefined /* ({ model, size }) => string|false | false | "serial" | "uuid" */, defaultFindManyLimit: 100, joins: false, validateSchema: true } }
```

- **`generateId`** (SRC `[S:core/src/db/adapter/get-id-field.ts]`, `[D:concepts/database]`): default = random base62 string in a `text` column. `"uuid"` = on UUID-capable adapters (Drizzle `pg`, Postgres Kysely) no JS id is generated and the DB default fills it; elsewhere `crypto.randomUUID()`; ids you pass must match the UUID regex. `false` = the DB generates every id. A function returns an id, or `false` to let the DB generate that model's id. `"serial"` = numeric ids returned as strings.
- **`validateSchema`** (1.7.3) is on by default, including in production. It compares the Drizzle schema object with what Better Auth writes, without querying the DB. Auth requests fail on a mismatch. `[D:concepts/database]`
- **CSRF checks** (SRC `[S:better-auth/src/api/middlewares/origin-check.ts]`): GET, HEAD and OPTIONS are skipped. Other methods: if the request has a `Cookie`, it needs a trusted `Origin` or `Referer`. Otherwise it gets 403 `INVALID_ORIGIN`, or `MISSING_OR_NULL_ORIGIN` when the header is absent. `/sign-in/email`, `/sign-up/email` (and magic-link / email-OTP sign-in) add Fetch-Metadata checks: cross-site `navigate` requests are blocked, and a present Origin is validated even without a cookie. `callbackURL`, `redirectTo`, `errorCallbackURL` and `newUserCallbackURL` must be relative or trusted. `disableOriginCheck:true` also disables CSRF checks unless `disableCSRFCheck` is set explicitly. This behaviour is deprecated.

## 4. `rateLimit`

- **Options** (SRC `[S:better-auth/src/context/create-context.ts]`). `enabled` defaults to `NODE_ENV==="production"`. `window` is 10 (the docs page says 60 s) and `max` is 100. `storage` defaults to `"secondary-storage"` if `secondaryStorage` is set, otherwise `"memory"`. `"database"` is also accepted. `modelName` defaults to `"rateLimit"`. `customStorage` needs an atomic `consume(key, { window, max }) → { allowed, retryAfter }` (1.7).
- **Built-in rules** (SRC `[S:better-auth/src/api/rate-limiter/index.ts]`):

  | Paths | Limit |
  |---|---|
  | Starting with `/sign-in` (including `/sign-in/sso`), `/sign-up`, `/change-password`, `/change-email` | 3 per 10 s |
  | `/request-password-reset`, `/send-verification-email`, `/forget-password*`, email-OTP send and reset | 3 per 60 s |
  | `/two-factor/*` (twoFactor plugin rule) | 3 per 10 s |
  | Passkey endpoints | No rule |

  - Precedence: default < built-in < plugin < `customRules`. `customRules` maps `"/path"` or `"/two-factor/*"` (relative to `basePath`) to `{ window, max }`, `false`, or `(request, currentRule) => rule | false`.
- **Rate-limit key** `` `${ip}|${path}` ``. `x-forwarded-for` counts only as a single value. With `trustedProxies`, the chain is walked from the right. IPv6 addresses are grouped by /64. In dev and test the IP is `127.0.0.1`. **In production with no IP, each path gets one shared bucket** (`no-trusted-ip|/path`) and one warning is logged. `disableIpTracking:true` turns rate limiting off entirely. `session.ipAddress` uses the same IP resolver.
- **Responses and storage.** A blocked request gets 429 with an `X-Retry-After` header in seconds. `auth.api` calls are never limited. Database storage uses the `rateLimit` table: `id`, `key` (unique), `count` (int), and `lastRequest` (bigint, epoch ms). Updates go through an atomic `incrementOne`, and expired rows are pruned. `[D:concepts/rate-limit]`

## 5. `databaseHooks`, `hooks`, errors, `disabledPaths`

- **`databaseHooks`** (SRC `[S:core/src/types/init-options.ts]`, `[B:1-5]`). Hooks exist for user, session, account and verification, each with `create`, `update` and `delete`, each with `before` and `after`. `before(data, ctx: GenericEndpointContext | null)` returns `false` to abort, `{ data }` to replace the data, or nothing. Use Better Auth field names. `after` runs **after commit** (since 1.5). `ctx` is `null` outside an endpoint, for example on direct `internalAdapter` calls. Throw `APIError` to abort.

```ts
import { createAuthMiddleware, APIError, isAPIError } from "better-auth/api";
hooks: {
  before: createAuthMiddleware(async (ctx) => { if (ctx.path === "/sign-up/email") throw new APIError("BAD_REQUEST", { message: "…" }); /* or return { context: { body } } */ }),
  after:  createAuthMiddleware(async (ctx) => { ctx.context.newSession /* {session,user} | null */; ctx.context.returned /* value | APIError */; }),
}
```

- **`hooks`** `[D:concepts/hooks]`. Each phase takes one function; branch on `ctx.path`. User hooks run before plugin hooks. `ctx` provides `body`, `query`, `headers`, `request?`, `json()`, `redirect()`, and signed-cookie helpers: `setSignedCookie` and `getSignedCookie(name, ctx.context.secret)`. `ctx.context` provides `secret`, `authCookies`, `password.{hash,verify}`, `adapter`, `internalAdapter`, `generateId`, `responseHeaders` and `runInBackground[OrAwait]`. During a 2FA challenge, `newSession` is `null`.
- **`onAPIError`** is `{ throw: false, onError(error, authCtx), errorURL: "/api/auth/error", customizeDefaultErrorPage }`.
- **`disabledPaths`**: `disabledPaths: ["/sign-up/email"]` returns 404 for HTTP requests only. SRC `[S:better-auth/src/api/index.ts]`

## 6. Drizzle adapter and the `auth` CLI

```ts
import { drizzleAdapter } from "@better-auth/drizzle-adapter";  // or "better-auth/adapters/drizzle"; RQB v2: ".../relations-v2"
database: drizzleAdapter(db, { provider: "pg", schema: { ...authSchema, user: appSchema.users }, usePlural: false,
  camelCase: false /* CLI column naming only (snake_case SQL by default) */, transaction: false, schemaName: undefined /* pg namespace */, debugLogs: false })
```

- **Schema keys** (SRC `[S:drizzle-adapter/src/drizzle-adapter.ts]`). The adapter looks up `schema[modelName]`, falling back to `db._.fullSchema`. Every model in use needs a key: `user`, `session`, `account`, `verification`, `twoFactor`, `passkey`, `ssoProvider`, and `rateLimit` when `storage:"database"`. A missing key throws `The model "x" was not found in the schema object`. With `usePlural`, the keys become `users`, `sessions`, and so on. To rename a table, set `user:{ modelName:"users" }` or re-key the schema object.
- **Field names.** The values in `fields` must be **Drizzle column property keys** (JS keys), because the adapter reads `schemaModel[fieldName]`. The SQL column name is whatever that Drizzle column declares. `[D:adapters/drizzle]`
- **Adapter capabilities.** With `provider: "pg"`, the adapter reports UUID and JSON support. `advanced.database.joins:true` needs Drizzle `relations` inside `schema`. In 1.7 it moved out of `experimental`.
- **`generate`** (`[D:concepts/cli]`, SRC `[S:cli/src/commands/generate.ts]`). Command: `npx auth@latest generate [--config src/auth.ts] [--output …] [--adapter drizzle --dialect postgresql] [-y] [-c cwd]`. The default Drizzle output is **`./auth-schema.ts`**. The docs say `schema.ts`. The config file is searched as `auth.ts` in `./`, `lib/` and `utils/`, with or without a `src/` prefix. `migrate` works only with Kysely. For Drizzle, run `drizzle-kit generate` and `drizzle-kit migrate`.
- **Other CLI commands.** `create-admin --email --name --role [--password] [--data] [--no-email-verified]`, `secret`, `info [--json]`, `upgrade`, `init`.
- **UUID schema output.** With `generateId:"uuid"` on pg, the generator emits `uuid("id").default(sql\`pg_catalog.gen_random_uuid()\`).primaryKey()` and `uuid(...)` foreign keys. SRC `[S:cli/src/generators/drizzle.ts]`

## 7. Server API, Node, Express, NestJS

- **The `auth` object** exposes `{ handler, fetch, api, options, $context: Promise<AuthContext>, $ERROR_CODES }`. SRC `[S:better-auth/src/auth/base.ts]`
- **`auth.api.x(...)`** takes `{ body, query, headers, asResponse?, returnHeaders?, returnStatus? }`. By default it returns the value. `returnHeaders` returns `{ headers, response }`; read cookies with `headers.getSetCookie()`. `asResponse` returns a `Response`. Failures throw `APIError`. `[D:concepts/api]`
- **Sessions and sign-in** (SRC `[S:better-auth/src/api/routes/*]`). `getSession({ headers, query?: { disableCookieCache } })` returns `{ session, user }` or `null`. `headers` is required, and a refresh sets cookies. `signInEmail({ body: { email, password, rememberMe?, callbackURL? }, headers })` returns `{ redirect, token, url?, user }`. When a 2FA challenge applies it returns `{ twoFactorRedirect, twoFactorMethods }` instead, and that shape is untyped.
- **Passwords.** `requestPasswordReset({ body: { email, redirectTo? } })` hits `/request-password-reset`; 1.7 routes have no `forgetPassword`. `resetPassword({ body: { newPassword, token } })`. `changePassword({ body: { newPassword, currentPassword, revokeOtherSessions? } })`. `setPassword` is server-only.
- **Session management.** `listSessions` requires a fresh session and returns the session tokens. `revokeSession({ body: { token } })`, `revokeSessions` and `revokeOtherSessions` revoke sessions. `updateSession` updates additional fields only.
- **`(await auth.$context).internalAdapter`** (SRC `[S:better-auth/src/db/internal-adapter.ts]`). `createUser(user, source)`: `source` is required in 1.7, for example `{ method: "admin" }`. Outside an endpoint it throws FORBIDDEN `validation_context_missing` when `validateUserInfo` is set. `createAccount({ userId, providerId: "credential", accountId: userId, password: await ctx.password.hash(pw) })`. Users: `findUserByEmail(email, { includeAccounts })` returns `{ user, accounts } | null`. Also `findUserById`, `updateUser` and `updatePassword(userId, hash)`. Sessions: `createSession(userId, dontRemember?, override?)`, `listSessions`, `deleteSession(token)`, `deleteSessions(tokens[])`, `deleteUserSessions(userId)`. Verification values: `createVerificationValue({ identifier, value, expiresAt })`, `findVerificationValue`, `consumeVerificationValue`, `deleteVerificationByIdentifier`. All of these run `databaseHooks`.
- **Node.** Use `import { toNodeHandler, fromNodeHeaders } from "better-auth/node"`. `toNodeHandler` builds the request URL from `x-forwarded-proto` and `host`, and passes **no socket IP**. SRC `[S:better-auth/src/integrations/node.ts]`
- **Express.** Mount with `app.all("/api/auth/*splat", toNodeHandler(auth))` on Express 5, or `/api/auth/*` on v4. **Mount it before `express.json()`.** ESM only. `[D:integrations/express]`
- **Fastify.** The documented handler rebuilds the body with `JSON.stringify(request.body)`. That would break form posts such as the SAML ACS. UNVERIFIED. `[D:integrations/fastify]`
- **NestJS** (community package `@thallesp/nestjs-better-auth@2.8.0`, `[D:integrations/nestjs]`). Peer deps: `better-auth >=1.5 <2`, `@nestjs/* ^11.1.6 || ^12`, `express ^5.1.0`. Fastify support is "beta". Setup: `NestFactory.create(AppModule, { bodyParser: false })`, then `AuthModule.forRoot({ auth, bodyParser: { json, urlencoded, rawBody }, disableGlobalAuthGuard, disableTrustedOriginsCors, disableControllers, middleware })`. It installs a **global AuthGuard**. `@AllowAnonymous()` and `@OptionalAuth()` relax it, and `@Session()` injects the session. `@Roles()` reads only `user.role`. `@Hook` needs `hooks:{}` in the auth config and `@DatabaseHook` needs `databaseHooks:{}` (per the README).

## 8. Cookies

- **Name.** `` `${secure ? "__Secure-" : ""}${advanced.cookies[n]?.name ?? `${cookiePrefix ?? "better-auth"}.${n}`}` ``. SRC `[S:better-auth/src/cookies/index.ts]`
- **When cookies are `Secure`.** First match wins: `useSecureCookies` → dynamic `baseURL.protocol` → a static `baseURL` starting with `https://` → `NODE_ENV==="production"`. So an https `baseURL` gives the `__Secure-` prefix even in dev.
- **Attributes.** The defaults are `httpOnly`, `sameSite:"lax"`, `path:"/"`, plus `domain` for cross-subdomain cookies. Merge order: defaults < `defaultCookieAttributes` < per-call < `advanced.cookies[n].attributes`.
- **Cookie base names.**

  | Base name | Notes |
  |---|---|
  | `session_token` | maxAge is `expiresIn`; no maxAge when `rememberMe:false` |
  | `session_data` | Cookie cache only; maxAge 300 |
  | `account_data`, `dont_remember` | — |
  | `two_factor` | 600 s |
  | `trust_device` | 30 d |
  | `better-auth-passkey` | Full name `better-auth.better-auth-passkey` |
  | `oauth_state`, `admin_session` | — |

  Chunked cookies get `.0`, `.1` suffixes.
- **Signed format.** `encodeURIComponent(value + "." + base64(HMAC-SHA256(secret, value)))`. The signature is 44 characters ending in `=`. `session_token` carries the DB `session.token`. SRC (better-call 1.4.0 `dist/crypto.mjs`)
- **Cookie-cache lag.** A revoked session stays valid on other devices until `cookieCache.maxAge` passes. `[D:concepts/session-management]`

## 9. `bearer` plugin (`import { bearer } from "better-auth/plugins"`)

SRC `[S:better-auth/src/plugins/bearer/index.ts]`.

- **Incoming token.** The before-hook reads `Authorization: Bearer <t>`; the scheme is case-insensitive. If `t` contains a `.`, it is treated as the signed cookie value. Otherwise it is treated as a **raw session token** and signed on the fly. `requireSignature:true` rejects raw tokens. After the HMAC check, it is injected as the `session_token` cookie. This works through `auth.api.getSession({ headers })` too.
- **Outgoing token.** When a session cookie is set, the after-hook adds a **`set-auth-token`** header carrying the **signed** value (`token.sig`), and lists that header in `Access-Control-Expose-Headers`.
- **Storage and CSRF.** The docs store the token in `localStorage`. A request whose original headers carry no Cookie skips the origin check. `[D:plugins/bearer]`

## 10. `twoFactor` plugin (`import { twoFactor } from "better-auth/plugins"`)

```ts
twoFactor({ issuer: "OCSO", totpOptions: { digits: 6, period: 30, disable: false },
  otpOptions: { sendOTP: async ({ user, otp }, ctx) => {}, period: 3 /* min */, storeOTP: "plain" },
  backupCodeOptions: { amount: 10, length: 10, storeBackupCodes: "plain" /*|"encrypted"|{encrypt,decrypt}*/, customBackupCodesGenerate },
  skipVerificationOnEnable: false, allowPasswordless: false, twoFactorCookieMaxAge: 600, trustDeviceMaxAge: 2592000,
  accountLockout: { enabled: true, maxFailedAttempts: 10, durationSeconds: 900 }, twoFactorTable: "twoFactor", schema })
```

- **Endpoints** (all POST; `[D:plugins/2fa]`, SRC `[S:better-auth/src/plugins/two-factor/index.ts]`):

  | Endpoint | Server API | Body and notes |
  |---|---|---|
  | `/two-factor/enable` | `enableTwoFactor` | `{ password, method?: "totp"\|"otp", issuer? }`. Returns `{ method:"totp", totpURI, backupCodes }` or `{ method:"otp" }` (1.7 union). |
  | `/two-factor/disable` | `disableTwoFactor` | `{ password? }` |
  | `/two-factor/get-totp-uri` | `getTOTPURI` | `{ password? }` |
  | `/two-factor/verify-totp` | `verifyTOTP` | `{ code, trustDevice? }` |
  | `/two-factor/send-otp` | `sendTwoFactorOTP` | — |
  | `/two-factor/verify-otp` | `verifyTwoFactorOTP` | — |
  | `/two-factor/generate-backup-codes` | `generateBackupCodes` | `{ password? }`; replaces existing codes |
  | `/two-factor/verify-backup-code` | `verifyBackupCode` | `{ code, disableSession?, trustDevice? }` |
  | (server-only) | `viewBackupCodes` | `{ body: { userId } }` |

- **Password rule.** A password is required unless `allowPasswordless` is on **and** the user has no credential password. So SSO-only or passkey-only users need `allowPasswordless:true` to enroll. SRC `[S:better-auth/src/utils/password.ts]`
- **Enrolment.** With TOTP, `twoFactorEnabled` stays `false` until `verify-totp` succeeds with a session, unless `skipVerificationOnEnable` is on. Re-enabling while a verified TOTP exists returns `TOTP_ALREADY_ENABLED` (1.7.3). OTP is enabled immediately and needs `sendOTP`.
- **Sign-in flow.** An after-hook runs **only on `/sign-in/email|username|phone-number`**. If `user.twoFactorEnabled` and there is no valid `trust_device` cookie, it **deletes the just-created session**, stores `2fa-<rand>` plus an attempt counter in `verification`, sets the signed `two_factor` cookie, and returns `{ twoFactorRedirect: true, twoFactorMethods }`. The verify endpoints then atomically consume the challenge and create the session. `trust_device` is an HMAC plus a database row, rotated on every sign-in. After too many failures, the account is locked with 429 `ACCOUNT_TEMPORARILY_LOCKED`.
- **Enforcement.** Passkey, SSO, social, magic-link and email-OTP sign-ins are **not** challenged. **There is no enforce option.** The docs say to "add custom hook handling", so making enrollment mandatory is app logic, such as a gate on `user.twoFactorEnabled`. `[D:plugins/2fa]`
- **Storage.** The TOTP secret is stored encrypted. Backup codes are plaintext JSON by default. SRC `[S:better-auth/src/plugins/two-factor/backup-codes/index.ts]`
- **Schema.** The plugin adds `user.twoFactorEnabled` (an optional bool) and a `twoFactor` table: id, userId (FK), secret, backupCodes, verified, failedVerificationCount, lockedUntil?.
- **Client.** `twoFactorClient({ onTwoFactorRedirect({ twoFactorMethods }) {}, twoFactorPage? })` from `better-auth/client/plugins`.

## 11. Passkey plugin (`@better-auth/passkey@1.7.5`)

```ts
import { passkey } from "@better-auth/passkey";               // client: import { passkeyClient } from "@better-auth/passkey/client"
passkey({ rpID: "app.example.com" /* default: baseURL hostname, else "localhost" */, rpName: "OCSO",
  origin: "https://app.example.com" /* string|string[]|null; default null → request Origin header is used as expectedOrigin */,
  authenticatorSelection: { authenticatorAttachment?, residentKey: "preferred", userVerification: "preferred" },
  advanced: { webAuthnChallengeCookie: "better-auth-passkey" },
  registration: { requireSession: true, resolveUser?, afterVerification?, extensions? }, authentication: { extensions? } })
```

- **Endpoints and server API names** (SRC `[S:passkey/src/routes.ts]`; challenges expire after 5 minutes):

  | Endpoint | Server API |
  |---|---|
  | `GET /passkey/generate-register-options` | `generatePasskeyRegistrationOptions` |
  | `POST /passkey/verify-registration` | `verifyPasskeyRegistration` |
  | `GET /passkey/generate-authenticate-options` | `generatePasskeyAuthenticationOptions` |
  | `POST /passkey/verify-authentication` | `verifyPasskeyAuthentication` |
  | `GET /passkey/list-user-passkeys` | `listPasskeys` |
  | `POST /passkey/delete-passkey` `{id}` | `deletePasskey` |
  | `POST /passkey/update-passkey` `{id,name}` | `updatePasskey` |

- **Client methods.** `authClient.passkey.addPasskey({ name?, authenticatorAttachment?, extensions?, context?, createSession? })`, `authClient.signIn.passkey({ autoFill?, extensions? })`, `authClient.passkey.listUserPasskeys()`, `.deletePasskey({ id })`, `.updatePasskey({ id, name })`. `[D:plugins/passkey]`
- **Registration** needs a session by default (`requireSession`) and goes through **`freshSessionMiddleware`**, so it fails once the session is older than `freshAge` (SRC). Passkey-first sign-up (`requireSession:false` plus `resolveUser`) has existed since 1.6. `[B:1-6]`
- **Sign-in** skips 2FA and has no dedicated rate-limit rule.
- **Table `passkey`.** id, name?, publicKey, userId (FK), credentialID, counter, deviceType, backedUp, transports?, createdAt?, aaguid?.

## 12. SSO plugin (`@better-auth/sso@1.7.5`; client `ssoClient()` from `@better-auth/sso/client`)

```ts
sso({ provisionUser: async ({ user, userInfo, token, provider }) => {}, provisionUserOnEveryLogin: false,
  organizationProvisioning: { disabled: false, defaultRole: "member", getRole },   // with the organization plugin
  defaultOverrideUserInfo: false, disableImplicitSignUp: false /* then signIn.sso needs requestSignUp:true */, trustEmailVerified: false /* deprecated */,
  domainVerification: { enabled: false, tokenPrefix: "better-auth-token" }, providersLimit: 10 /* number | (user) => n; 0 disables registration */,
  defaultSSO: [{ providerId, domain, oidcConfig?, samlConfig? }], redirectURI: undefined /* shared OIDC callback */,
  resolveUser, guardProviderMutation, resolvePrivateKey, modelName: "ssoProvider", fields, schema: { ssoProvider: { additionalFields } },
  saml: { enableInResponseToValidation: true, allowIdpInitiated: false, requestTTL: 300000, clockSkew: 300000, requireTimestamps: false,
    algorithms: { onDeprecated: "warn" }, maxResponseSize: 262144, maxMetadataSize: 102400, enableSingleLogout: false, idpInitiatedCallbackUrl } })
```

Types come from SRC `[S:sso/src/types.ts]`. The docs table gives `allowIdpInitiated` a default of `true`, but the source and the 1.7 upgrade guide say `false`.

**`registerSSOProvider`** (`POST /sso/register`, session required). Body from SRC `[S:sso/src/routes/schemas.ts]`:

```ts
{ providerId, issuer /* URL */, domain: "acme.com,acme.co.uk", organizationId?, overrideUserInfo?,
  oidcConfig?: { clientId, clientSecret?, discoveryEndpoint?, skipDiscovery?, authorizationEndpoint?, tokenEndpoint?, userInfoEndpoint?, jwksEndpoint?,
    tokenEndpointAuthentication?: "client_secret_basic"|"client_secret_post"|"private_key_jwt", scopes? /* openid,email,profile,offline_access */,
    pkce? /* true */, mapping?: { email, name, emailVerified?, image?, extraFields? } /* strict; `id` removed in 1.7 */ },
  samlConfig?: { entryPoint, cert? /* PEM|PEM[] */, audience?, callbackUrl? /* IdP-initiated landing only */, idpInitiatedCallbackUrl?,
    idpMetadata: { metadata } | { entityID, cert?, singleSignOnService? }, spMetadata?: { metadata?, entityID?, binding?, privateKey?, … },
    wantAssertionsSigned?, authnRequestsSigned?, signatureAlgorithm?, digestAlgorithm?, identifierFormat?, privateKey?,
    mapping?: { email, name, emailVerified?, firstName?, lastName?, extraFields? } } }
```

- **Who can register** (SRC `[S:sso/src/routes/sso.ts]`). **Any user with a session** can register, up to `providersLimit` rows per `userId` (default **10**). The limit is checked inside the handler, so `auth.api` calls count too. When `organizationId` is set, the caller must be an owner or admin of that organization. `providerId` must not collide with social provider ids, `trustedProviders`, `credential`, or `defaultSSO` ids (422). A server-side call still needs a signed-in user's `headers`, and that user becomes `ssoProvider.userId`. `disabledPaths` blocks HTTP only.
- **SAML** `[D:plugins/sso]`. A provider needs `cert` or `idpMetadata.metadata`, otherwise `CERT_SOURCE_MISSING`. A manual config needs `idpMetadata.entityID`. Certificates can be given as an array, for rotation. Assertions must carry an `AudienceRestriction` matching the SP entityID or `audience`, and `Recipient`/`Destination` are checked.
- **OIDC discovery.** Discovery fetches `{issuer}/.well-known/openid-configuration`. **Every discovered URL must be in `trustedOrigins`**, else `discovery_untrusted_origin`. Redirects are refused (`oidc_endpoint_redirect`), with a 10 s timeout. The account subject is the verified `sub` for OIDC and the signed `NameID` for SAML.
- **Sign-in.** On the client: `authClient.signIn.sso({ email | domain | organizationSlug | providerId, callbackURL /* required */, errorCallbackURL?, newUserCallbackURL?, scopes?, loginHint?, requestSignUp? })`. On the server: `auth.api.signInSSO({ body })`. For OIDC, the email is sent as `login_hint`.
- **Paths under `basePath`** (SRC `[S:sso/src/index.ts]`):

  | Path | Purpose |
  |---|---|
  | `GET /sso/callback/:providerId` (and `/sso/callback` if `redirectURI` is set) | OIDC callback |
  | `GET\|POST /sso/saml2/sp/acs/:providerId` | **SAML ACS**; the origin check is skipped |
  | `GET /sso/saml2/sp/metadata?providerId=&format=xml\|json` | SP metadata (`spMetadata`) |
  | `/sso/saml2/sp/slo/:providerId`, `POST /sso/saml2/logout/:providerId` | Single logout |
  | `GET /sso/providers`, `GET /sso/get-provider` | Read providers |
  | `POST /sso/update-provider` | Update; full mappings only |
  | `POST /sso/delete-provider` | Delete; also deletes linked accounts |
  | `POST /sso/request-domain-verification`, `POST /sso/verify-domain` | Domain verification |

- **Account linking** (SRC `[S:sso/src/routes/sso.ts]`, `[S:better-auth/src/oauth2/link-account.ts]`). An SSO sign-in links to an existing account with the same email only if all three hold: (1) the provider is trusted, or the IdP marked the email as verified ("trusted" means `domainVerification.enabled`, `provider.domainVerified`, and the email's domain listed in `provider.domain`; the IdP flag is forced to false unless `trustEmailVerified` is set); (2) the local `user.emailVerified` is true; (3) linking is enabled and `disableImplicitLinking` is off. Otherwise sign-in fails with `account not linked`. `trustProviderByName:false` means `trustedProviders` is never used for SSO. In 1.7, `resolveUser` can override this by returning `{ action: "link", userId, profile }`, `"continue"`, or `"reject"`; it needs native DB transactions.
- **Domain verification.** A new provider can't sign anyone in until the TXT record `_better-auth-token-{providerId}` exists on **every** listed domain. The token lasts one week. `defaultSSO` entries are checked **before** database rows and count as `domainVerified` (SRC). The docs say they apply only "when no DB match". UNVERIFIED which is intended.
- **Table `ssoProvider`.** Columns: id, issuer, domain, oidcConfig (JSON text), samlConfig (JSON text), userId (FK), providerId (unique), organizationId?, domainVerified? (only when domain verification is on), plus additionalFields. `clientSecret` is stored **unencrypted**; `packages/sso/src` makes no encryption calls. List and get responses are sanitized (`clientIdLastFour`). SRC `[S:sso/src/routes/providers.ts]`

## 13. `admin` plugin (`import { admin } from "better-auth/plugins"`, client `adminClient()`)

- **Options.** `admin({ defaultRole: "user", adminRoles: ["admin"], adminUserIds: [], impersonationSessionDuration: 3600, defaultBanReason: "No reason", defaultBanExpiresIn, bannedUserMessage, ac, roles })`. `[D:plugins/admin]`
- **Schema.** It adds `user.role` (a string; arrays are comma-joined), `banned`, `banReason`, `banExpires` and `session.impersonatedBy`. A session-create hook blocks banned users.
- **Server APIs** (SRC `[S:better-auth/src/plugins/admin/admin.ts]`): Users: `createUser`, `listUsers`, `getUser`, `setRole`, `setUserPassword`, `adminUpdateUser`, `removeUser`. Bans and sessions: `banUser`, `unbanUser`, `listUserSessions`, `revokeUserSession`, `revokeUserSessions`. Other: `impersonateUser`, `stopImpersonating`, `userHasPermission`.
- **`createUser({ body: { email, password?, name, role?, data? } })`** (SRC `[S:better-auth/src/plugins/admin/routes.ts]`). Without a password, no credential account is created. `role` and `data.role` are permission-checked, but **a call with no headers and no request skips every permission check**. When enumeration protection is on, add the admin fields to `customSyntheticUser`.
- **Is the plugin needed?** Not for roles alone: `user.additionalFields.role` with `input:false` is the documented self-managed pattern. The plugin adds bans, impersonation, user listing, and `npx auth create-admin`. `[D:concepts/database]`

## 14. React client

```ts
import { createAuthClient } from "better-auth/react";
import { twoFactorClient, adminClient, inferAdditionalFields } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";
import { ssoClient } from "@better-auth/sso/client";
export const authClient = createAuthClient({ baseURL: "https://api.example.com" /* omit if same origin; may include path */, basePath: "/api/auth",
  plugins: [twoFactorClient({ onTwoFactorRedirect({ twoFactorMethods }) {} }), passkeyClient(), ssoClient(), inferAdditionalFields<typeof auth>()],
  fetchOptions: { onError: async (ctx) => { if (ctx.response.status === 429) ctx.response.headers.get("X-Retry-After"); } /* auth: { type: "Bearer", token } */ } });
const { data, isPending, error, refetch } = authClient.useSession();
```

- The client sets `credentials:"include"` by default where supported. SRC `[S:better-auth/src/client/config.ts]`
- Every method also accepts per-call `fetchOptions` (Better Fetch). `[D:concepts/client]`

## 15. Changes in 1.5 → 1.7

- **1.5** (2026-03-01, `[B:1-5]`): New `auth` CLI. Adapters split into their own packages (still re-exported). Unified `AuthMiddleware` hooks, dynamic `baseURL`, and `secrets`. Rate-limiter hardening: 3 per 10 s on sign-in, 3 per 60 s on reset, IPv6 grouped by /64. Verification records can live in secondary storage. Database after-hooks run after commit. New `/update-session` endpoint; `getMigrations` moved to `better-auth/db/migration`. Removed: `/forget-password/email-otp`, `sendChangeEmailVerification` (now `sendChangeEmailConfirmation`), `onEmailVerification` (now `afterEmailVerification`), and `useNumberId` (now `generateId:"serial"`). `apiKey` moved to `@better-auth/api-key`.
- **1.6** (2026-04-06, `[B:1-6]`): **`freshAge` counts from `createdAt`.** SAML `InResponseTo` validation is on by default. Cookie-cache `maxAge` is aligned with the session. Non-blocking scrypt. Passkey registration before a session exists. OpenTelemetry spans. `oidcProvider` deprecated.
- **1.7** (2026-08-18, `[B:1-7]`, `[B:1-7-rc]`, `[D:guides/1-7-upgrade-guide]`): Proxy headers are no longer trusted. Atomic state: custom stores need `consume`, `increment` and `getAndDelete`. SAML: IdP-initiated sign-in off, ACS path `/sp/acs/:id`, `mapping.id` removed, `wantAssertionsSigned` checks the assertion itself, and partial `update-provider` updates rejected. `enableTwoFactor` returns a union. Magic-link and OTP sign-in now clear unproven credentials. New `user.validateUserInfo`. Renames: `getIp` → `getIP`, `experimental.joins` → `advanced.database.joins`. `oidcProvider` removed in favour of `@better-auth/oauth-provider`; MCP moved to `@better-auth/mcp`. Microsoft accounts now use `oid`.
- **1.7 patches** (`[S:better-auth/CHANGELOG.md]`): 1.7.1: `migrate` refuses required columns that have no default. 1.7.3: `issuer` removed again, runtime schema validation, TOTP re-enrollment guard. 1.7.4: instrumentation toggle. 1.7.5: `database.schemaName` for pg.

## 16. Security advisories (`gh api …/security-advisories`)

**No published advisory lists 1.7.0 GA or later as affected.** Every fixed range ends at or before `1.7.0-rc.5`.

| Advisory | Severity | Issue | Fixed in |
|---|---|---|---|
| GHSA-8c5h-wx78-2cfg (2026-08-11) | High | SSO stale domain verification; unverified-domain org assignment | sso 1.6.27 / 1.7.0-rc.5 |
| GHSA-prpr-5gj3-qqhg | High | SSO takeover via comma domains, orphaned accounts after delete, missing SAML Audience check, SLO XSS | 1.6.21 / 1.7.0-beta.10 |
| GHSA-qq9h-g4jm-xgf3 | High | Magic-link / OTP pre-account hijack | 1.6.22 |
| GHSA-5rr4-8452-hf4v (CVE-2026-53513) | Critical | SSO registration SSRF via unvalidated OIDC endpoints | sso 1.6.11 |
| GHSA-gv74-j8m3-fg5f (CVE-2026-53515) | High | SSO registration allowed any org member (no role check) | sso 1.6.11 |
| GHSA-g38m-r43w-p2q7 (CVE-2026-53516) | High | Pre-account hijack via OAuth implicit linking | 1.6.11 |
| GHSA-p6v2-xcpg-h6xw (CVE-2026-45364) | High | Rate limiter keyed IPv6 per address (prefix rotation bypass) | 1.4.17 / 1.5.0-beta.9 |
| GHSA-xg6x-h9c9-2m83 | High | 2FA bypass via premature `cookieCache` session | 1.4.9 (affected 1.4.5) |
| GHSA-x732-6j76-qmhm | High | `//` path normalisation bypassed `disabledPaths` and rate limits | 1.4.6 |
| GHSA-4vcf-q4xf-f48m | High | Passkey deletion IDOR | passkey 1.4.0 |

The advisories list these workarounds for risky configurations (`[GHSA-8c5h-wx78-2cfg]`, `[GHSA-prpr-5gj3-qqhg]`):

- Set `providersLimit: 0`, or gate `/sso/register`, `/sso/update-provider` and `/sso/verify-domain` in the app.
- Set `accountLinking.disableImplicitLinking: true`.
- Set `organizationProvisioning.disabled: true`.
- Leave `saml.enableSingleLogout` off.

## Decisions for OCSO

Recorded in ADR-025; verified against the installed 1.7.5 source and by tests (`packages/application/test/auth-server.int.test.ts`, `apps/api/test/int/auth-*.int.test.ts`, `apps/api/test/unit/auth-surface.test.ts`, `apps/web/e2e/auth-and-roles.spec.ts`).

- **Packages:** `better-auth`, `@better-auth/passkey`, `@better-auth/sso`, `@better-auth/core` pinned at 1.7.5 in the catalog; `better-auth/minimal` (no Kysely) with `better-auth/adapters/drizzle`. Telemetry off. The `auth` CLI is not a dependency: the Drizzle tables were written by hand to OCSO conventions and are checked at start-up by Better Auth's own schema validation (`advanced.database.validateSchema`, default on).
- **Models:** user = `users` (`role`/`status` as `additionalFields`, `input: false`); `authSessions`, `authAccounts`, `authVerifications` (`storeIdentifier: 'hashed'`), `authTwoFactors`, `authPasskeys`, `authSsoProviders`, `authRateLimits`; UUIDv7 ids through `generateId`. Adapter `transaction: true` (SSO provisioning relies on it — hooks that read the user must use `ctx.context.internalAdapter`, not a separate connection).
- **Sessions:** `expiresIn` = absolute lifetime with `disableSessionRefresh` (gotcha: sliding refresh re-issues the cookie, which never reaches the browser when the BFF calls the API server-to-server); OCSO's idle window in a before-hook. `freshAge` = absolute lifetime (gotcha 8 above). Bearer plugin with `requireSignature`, listed **after** `twoFactor` so a sign-in that turns into a 2FA challenge does not expose the discarded session in `set-auth-token`.
- **Surface:** plugin before-hooks run for `auth.api.*` calls too, but `disabledPaths` and rate limits only for HTTP — OCSO's policy plugin enforces an HTTP allowlist by route template (`ctx.request` present), so parameterised routes are covered.
- **Sign-up off; users created by OCSO in its own transaction** (credential account + `reset-password:` verification token for invites, identifier hashed exactly like Better Auth). Better Auth's `/reset-password` accepts the token and creates the credential account.
- **2FA enforcement is OCSO's** (none in Better Auth): session `authMethod` recorded in `databaseHooks.session.create.before` from `ctx.path`; `allowPasswordless: true` so SSO/passkey-only users can enrol.
- **SSO:** `resolveUser` (new in 1.7) implements the provisioning policy instead of `trustEmailVerified`/domain verification; providers registered through `auth.api` with `skipDiscovery` after OCSO's own discovery (gotcha 12: discovery URLs must be trusted origins known at start-up). Provider owner = acting Tech Admin (Better Auth's delete checks ownership).
- **Rate limits:** database storage keyed by `x-ocso-client-ip` (`ipAddressHeaders`), custom rules per path (defaults of 3/10 s are too tight for a shift change behind one NAT); OCSO's per-account throttle kept.
- **Not used:** `admin` plugin (conflicting role/ban model), email OTP 2FA, trust-device cookies, domain verification, organization plugin, SAML single logout, cookie cache.
