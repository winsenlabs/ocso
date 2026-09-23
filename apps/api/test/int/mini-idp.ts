import { createServer, type Server } from 'node:http';
import { createSign, generateKeyPairSync } from 'node:crypto';

export interface IdpUser {
  sub: string;
  email: string;
  name: string;
}

/**
 * A minimal OIDC identity provider for tests: discovery, JWKS and a token
 * endpoint that issues an RS256 ID token for `nextUser`. The authorization
 * step is skipped — tests call OCSO's callback with any code and the state
 * from the authorization URL.
 */
export class MiniIdp {
  readonly clientId = 'ocso-client';
  nextUser: IdpUser = { sub: 'user-1', email: 'user@corp.test', name: 'User' };
  nonce: string | undefined;
  private server: Server | null = null;
  private readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  issuer = '';

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', this.issuer);
      const json = (body: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/.well-known/openid-configuration') {
        return json({
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`,
          jwks_uri: `${this.issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          scopes_supported: ['openid', 'email', 'profile'],
        });
      }
      if (url.pathname === '/jwks') {
        return json({ keys: [{ ...this.keys.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] });
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        req.resume();
        return req.on('end', () => json({ access_token: 'access-token', token_type: 'Bearer', expires_in: 3600, id_token: this.idToken() }));
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as { port: number };
    this.issuer = `http://127.0.0.1:${port}`;
    return this.issuer;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  private idToken(): string {
    const now = Math.floor(Date.now() / 1000);
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
    const payload = b64({
      iss: this.issuer,
      aud: this.clientId,
      sub: this.nextUser.sub,
      email: this.nextUser.email,
      email_verified: true,
      name: this.nextUser.name,
      iat: now,
      exp: now + 300,
      ...(this.nonce ? { nonce: this.nonce } : {}),
    });
    const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(this.keys.privateKey).toString('base64url');
    return `${header}.${payload}.${signature}`;
  }
}
