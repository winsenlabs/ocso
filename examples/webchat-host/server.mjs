// Example host site for the OCSO customer web chat (docs/archive/specs/07 §4, docs/archive/specs/08 §4).
//
// A stand-in for *your* website: it embeds the widget with one script tag and,
// for a "signed-in" customer, signs a short-lived HS256 JWT that the page hands
// to OcsoWebChat.identify(). Only Node built-ins; no install step.
//
//   OCSO_URL=http://localhost:3000 \
//   OCSO_WEBCHAT_KEY=<channel public key> \
//   OCSO_HOST_JWT_SECRET=<the channel's hostJwtSecret, optional> \
//   node examples/webchat-host/server.mjs            # → http://localhost:5440
//
// Add this site's origin (e.g. http://localhost:5440) to the channel's
// `settings.allowedOrigins`, otherwise the chat refuses to be framed here.
// In a real site the /token endpoint sits behind your own login and uses your
// customer id as `sub`; never ship the secret to the browser.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT ?? 5440);
const ocsoUrl = (process.env.OCSO_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const key = process.env.OCSO_WEBCHAT_KEY ?? '';
const secret = process.env.OCSO_HOST_JWT_SECRET ?? '';
const issuer = process.env.OCSO_HOST_JWT_ISSUER;
const audience = process.env.OCSO_HOST_JWT_AUDIENCE;
if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new Error('Set OCSO_WEBCHAT_KEY to the web chat channel public key');

const escapeAttr = (value) => value.replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);
const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8')
  .replaceAll('{{OCSO_URL}}', escapeAttr(ocsoUrl))
  .replaceAll('{{WEBCHAT_KEY}}', escapeAttr(key))
  .replaceAll('{{IDENTIFY}}', secret ? 'on' : 'off');

const b64url = (input) => Buffer.from(input).toString('base64url');

/** HS256 JWT for the channel's host identity setting: sub = your customer id. */
function signCustomerToken(customerId, name) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { sub: customerId, name, iat: now, exp: now + 300, ...(issuer ? { iss: issuer } : {}), ...(audience ? { aud: audience } : {}) };
  const input = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(page);
  }
  if (req.method === 'POST' && url.pathname === '/token') {
    if (!secret) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'identify is not configured (OCSO_HOST_JWT_SECRET)' }));
    }
    // Demo only: pretend the visitor is signed in as this customer.
    const customer = (url.searchParams.get('customer') ?? 'cus-demo-001').replace(/[^\w-]/g, '').slice(0, 64) || 'cus-demo-001';
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ token: signCustomerToken(customer, url.searchParams.get('name')?.slice(0, 80) ?? 'Demo Customer') }));
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});

server.listen(port, 'localhost', () => console.log(`webchat host example on http://localhost:${port} (OCSO ${ocsoUrl})`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
