import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { MODULE_METADATA, PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { ACCESS_KEY } from '../../src/common/decorators.js';
import { FEATURE_MODULES } from '../../src/app.module.js';

type Ctor = new (...args: never[]) => unknown;

function controllersOf(modules: readonly Ctor[]): Ctor[] {
  return modules.flatMap((m) => (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, m) as Ctor[] | undefined) ?? []);
}

/**
 * Deny-by-default coverage (T1.5.4): every HTTP route must declare exactly one
 * access rule. A new route without @Public/@Authenticated/@RequirePermission
 * fails this test before it can ship.
 */
describe('route access coverage', () => {
  const controllers = controllersOf(FEATURE_MODULES as unknown as Ctor[]);

  it('finds controllers', () => {
    expect(controllers.length).toBeGreaterThan(0);
  });

  it('every route declares an access rule', () => {
    const missing: string[] = [];
    for (const controller of controllers) {
      const proto = controller.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const isRoute = Reflect.hasMetadata(PATH_METADATA, handler) && Reflect.hasMetadata(METHOD_METADATA, handler);
        if (!isRoute) continue;
        const rule = Reflect.getMetadata(ACCESS_KEY, handler) ?? Reflect.getMetadata(ACCESS_KEY, controller);
        if (!rule) missing.push(`${controller.name}.${name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

/**
 * The complete list of routes reachable without a session. Everything else
 * requires a valid session (and usually a permission). Adding a public route
 * means adding it here, which makes it an explicit, reviewed decision.
 */
const PUBLIC_ROUTES = [
  'GET /.well-known/jwks.json', // public keys for customer-claims verification
  'GET /blobs/*path', // signed, expiring media URLs (signature checked in the handler)
  'GET /channels/:segment/:publicKey/webhook', // provider handshake: Meta verify-token challenge; other kinds reject GET
  'POST /channels/:segment/:publicKey/webhook', // provider webhooks: Meta X-Hub-Signature-256 (HMAC-SHA256 of raw body), Twilio X-Twilio-Signature (HMAC-SHA1 of public URL + form params)
  'GET /health/live',
  'GET /health/ready',
  'GET /oauth/mcp/callback', // OAuth 2.1 redirect (single-use hashed state)
  'GET /public/webchat/:publicKey/config',
  'GET /public/webchat/:publicKey/messages', // visitor token required in the handler
  'GET /public/webchat/:publicKey/stream', // visitor token required in the handler
  'POST /public/webchat/:publicKey/attachments', // visitor token required in the handler
  'POST /public/webchat/:publicKey/csat', // visitor token required in the handler
  'POST /public/webchat/:publicKey/messages', // visitor token required in the handler
  'POST /public/webchat/:publicKey/session',
  'POST /v1/auth/login',
  'GET /v1/setup/status',
  'POST /v1/setup', // one-time setup token, refused once a user exists
];

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

describe('public surface', () => {
  it('only the reviewed routes are public', () => {
    const controllers = controllersOf(FEATURE_MODULES as unknown as Ctor[]);
    const found: string[] = [];
    for (const controller of controllers) {
      const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '').replace(/^\/|\/$/g, '');
      const proto = controller.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function' || !Reflect.hasMetadata(METHOD_METADATA, handler)) continue;
        const rule = (Reflect.getMetadata(ACCESS_KEY, handler) ?? Reflect.getMetadata(ACCESS_KEY, controller)) as { kind: string } | undefined;
        if (rule?.kind !== 'public') continue;
        const method = METHODS[Reflect.getMetadata(METHOD_METADATA, handler) as number] ?? '?';
        const sub = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '').replace(/^\/|\/$/g, '');
        found.push(`${method} /${[base, sub].filter(Boolean).join('/')}`);
      }
    }
    expect(found.sort()).toEqual([...PUBLIC_ROUTES].sort());
  });
});
