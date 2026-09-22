import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { customers, signingKeys, type Db, type DbOrTx } from '@ocso/db';
import type { SecretStore } from '@ocso/secrets';
import { recordAudit } from '../audit/audit.js';
import type { ActorContext } from '../shared/context.js';

const PURPOSE = 'customer_claims';
export const CLAIMS_TTL_SECONDS = 120;
/** Retiring keys stay published long after the last token they signed expired (verifier caches). */
const RETIRE_AFTER_SECONDS = 24 * 3600;
const KEY_CACHE_MS = 60_000;

export interface CustomerClaimsInput {
  customerId: string;
  conversationId: string;
  agentId: string;
  connectionId: string;
  scopes: readonly string[];
}

export interface PublicJwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
  kid: string;
  alg: 'ES256';
  use: 'sig';
}

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** RFC 7638 thumbprint: stable kid derived from the public key itself. */
function thumbprint(jwk: { crv: string; kty: string; x: string; y: string }): string {
  return createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url');
}

/**
 * Short-lived customer identity claims for trusted tool servers (docs/08 §4,
 * PM/BUILD-PLAN E5.6): ES256 JWT with only identifiers and scopes, verifiable
 * through the public JWKS at `/.well-known/jwks.json`. No secrets, no PII
 * beyond the customer reference the business system already knows.
 */
export class CustomerClaimsIssuer {
  private active: { kid: string; key: KeyObject; loadedAt: number } | null = null;

  constructor(
    private readonly options: { db: Db; secrets: SecretStore; issuer: string; ttlSeconds?: number | undefined; now?: (() => Date) | undefined },
  ) {}

  async issue(input: CustomerClaimsInput): Promise<string> {
    const { kid, key } = await this.activeKey();
    const [customer] = await this.options.db.select({ externalRef: customers.externalRef }).from(customers).where(eq(customers.id, input.customerId));
    const now = Math.floor(this.now().getTime() / 1000);
    const payload = {
      iss: this.options.issuer,
      // The business system's own reference when OCSO knows it; otherwise an opaque OCSO id.
      sub: customer?.externalRef ?? `ocso:customer:${input.customerId}`,
      aud: `ocso-mcp:${input.connectionId}`,
      iat: now,
      nbf: now - 5,
      exp: now + (this.options.ttlSeconds ?? CLAIMS_TTL_SECONDS),
      jti: randomUUID(),
      cid: input.conversationId,
      agt: input.agentId,
      scope: [...input.scopes].sort().join(' '),
    };
    const signingInput = `${b64url({ alg: 'ES256', typ: 'JWT', kid })}.${b64url(payload)}`;
    const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
    return `${signingInput}.${signature.toString('base64url')}`;
  }

  /** Public keys verifiers may accept: the active key and keys still retiring. */
  async jwks(): Promise<{ keys: PublicJwk[] }> {
    await this.activeKey();
    const rows = await this.options.db
      .select({ kid: signingKeys.kid, jwk: signingKeys.publicJwk })
      .from(signingKeys)
      .where(and(eq(signingKeys.purpose, PURPOSE), inArray(signingKeys.status, ['ACTIVE', 'RETIRING'])));
    return { keys: rows.map((r) => ({ kty: r.jwk['kty']!, crv: r.jwk['crv']!, x: r.jwk['x']!, y: r.jwk['y']!, kid: r.kid, alg: 'ES256', use: 'sig' })) };
  }

  async listKeys(): Promise<Array<{ kid: string; status: string; createdAt: string; retiringAt: string | null }>> {
    const rows = await this.options.db.select().from(signingKeys).where(eq(signingKeys.purpose, PURPOSE)).orderBy(sql`${signingKeys.createdAt} DESC`);
    return rows.map((r) => ({ kid: r.kid, status: r.status, createdAt: r.createdAt.toISOString(), retiringAt: r.retiringAt?.toISOString() ?? null }));
  }

  /** New active key; the previous one keeps verifying until retired. */
  async rotate(actor: ActorContext): Promise<{ kid: string }> {
    const kid = await this.options.db.transaction(async (tx) => {
      await lockPurpose(tx);
      await tx.update(signingKeys).set({ status: 'RETIRING', retiringAt: this.now() }).where(and(eq(signingKeys.purpose, PURPOSE), eq(signingKeys.status, 'ACTIVE')));
      const created = await this.createKey(tx);
      await recordAudit(tx, actor, { action: 'security.signing_key_rotated', targetType: 'signing_key', targetId: created, summary: 'Customer claims signing key rotated' });
      return created;
    });
    this.active = null;
    return { kid };
  }

  /** Scheduler: retire keys past the grace window and destroy their private halves. */
  async retireExpired(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - RETIRE_AFTER_SECONDS * 1000);
    const rows = await this.options.db
      .update(signingKeys)
      .set({ status: 'RETIRED', retiredAt: this.now() })
      .where(and(eq(signingKeys.purpose, PURPOSE), eq(signingKeys.status, 'RETIRING'), lt(signingKeys.retiringAt, cutoff)))
      .returning({ ref: signingKeys.privateKeyRef });
    for (const row of rows) await this.options.secrets.delete(row.ref).catch(() => {});
    return rows.length;
  }

  private async activeKey(): Promise<{ kid: string; key: KeyObject }> {
    if (this.active && Date.now() - this.active.loadedAt < KEY_CACHE_MS) return this.active;
    let [row] = await this.selectActive(this.options.db);
    if (!row) {
      row = await this.options.db.transaction(async (tx) => {
        await lockPurpose(tx);
        const [existing] = await this.selectActive(tx);
        if (existing) return existing;
        await this.createKey(tx);
        return (await this.selectActive(tx))[0]!;
      });
    }
    const key = createPrivateKey(await this.options.secrets.resolve(row.privateKeyRef));
    this.active = { kid: row.kid, key, loadedAt: Date.now() };
    return this.active;
  }

  private selectActive(db: DbOrTx) {
    return db.select().from(signingKeys).where(and(eq(signingKeys.purpose, PURPOSE), eq(signingKeys.status, 'ACTIVE')));
  }

  private async createKey(tx: DbOrTx): Promise<string> {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string; y: string };
    const kid = thumbprint(jwk);
    const secret = await this.options.secrets.put({
      name: `customer-claims-key-${kid.slice(0, 12)}`,
      kind: 'SIGNING_KEY',
      value: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      usedBy: 'customer identity claims',
    });
    await tx.insert(signingKeys).values({ kid, purpose: PURPOSE, alg: 'ES256', publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, privateKeyRef: secret.ref, status: 'ACTIVE' });
    return kid;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

const lockPurpose = (tx: DbOrTx) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ocso:signing-key:${PURPOSE}`}))`);
