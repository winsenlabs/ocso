import { createHash } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import { mcpOauthPending, type Db } from '@ocso/db';
import type { McpPendingAuthorization } from '@ocso/mcp';
import type { SecretStore } from '@ocso/secrets';
import { z } from 'zod';
import { revokeSecrets } from './records.js';

export type PendingRow = typeof mcpOauthPending.$inferSelect;

/** Only the hash of `state` is stored, so a database read cannot replay a callback. */
export const hashState = (state: string): string => createHash('sha256').update(state, 'utf8').digest('hex');

const PendingSchema = z.object({
  connectionId: z.string().min(1),
  state: z.string().min(1),
  codeVerifier: z.string().min(1),
  issuer: z.string().min(1),
  authorizationServerUrl: z.string().min(1),
  authorizationServerMetadata: z.record(z.string(), z.unknown()),
  clientInformation: z.object({
    issuer: z.string().min(1),
    clientId: z.string().min(1),
    clientSecret: z.string().optional(),
    clientSecretExpiresAt: z.number().optional(),
    registration: z.enum(['CLIENT_ID_METADATA_DOCUMENT', 'PRE_REGISTERED', 'EXISTING', 'DYNAMIC']),
  }),
  redirectUri: z.string().min(1),
  resource: z.string().min(1),
  scopes: z.array(z.string()),
  network: z.enum(['PUBLIC', 'INTERNAL']),
  expiresAt: z.number(),
});

/**
 * In-flight OAuth authorizations (ADR-021). The pending record holds the PKCE
 * verifier and possibly a client secret, so its body lives in the SecretStore;
 * `mcp_oauth_pending` keys it by the state hash. `take` deletes the row first
 * — a state value can complete at most one callback.
 */
export class OAuthPendingStore {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    private readonly now: () => Date,
  ) {}

  async save(userId: string, pending: McpPendingAuthorization): Promise<void> {
    await this.purgeExpired();
    const expiresAt = new Date(pending.expiresAt);
    const meta = await this.secrets.put({
      name: `mcp oauth pending ${pending.connectionId}`,
      kind: 'OTHER',
      value: JSON.stringify(pending),
      usedBy: `mcp:${pending.connectionId}`,
      expiresAt,
    });
    try {
      await this.db.insert(mcpOauthPending).values({
        stateHash: hashState(pending.state),
        connectionId: pending.connectionId,
        userId,
        pendingRef: meta.ref,
        expiresAt,
      });
    } catch (err) {
      await revokeSecrets(this.secrets, [meta.ref]);
      throw err;
    }
  }

  /** Single use: delete by state hash, then load and discard the secret body. Null when unknown or already used. */
  async take(state: string): Promise<{ row: PendingRow; pending: McpPendingAuthorization | null } | null> {
    const [row] = await this.db.delete(mcpOauthPending).where(eq(mcpOauthPending.stateHash, hashState(state))).returning();
    if (!row) return null;
    try {
      const parsed = PendingSchema.safeParse(JSON.parse(await this.secrets.resolve(row.pendingRef)));
      return { row, pending: parsed.success ? (parsed.data as McpPendingAuthorization) : null };
    } catch {
      return { row, pending: null };
    } finally {
      await revokeSecrets(this.secrets, [row.pendingRef]);
    }
  }

  async purgeExpired(): Promise<number> {
    const rows = await this.db
      .delete(mcpOauthPending)
      .where(lt(mcpOauthPending.expiresAt, this.now()))
      .returning({ ref: mcpOauthPending.pendingRef });
    await revokeSecrets(
      this.secrets,
      rows.map((r) => r.ref),
    );
    return rows.length;
  }

  /** Pending secret refs of connections about to be deleted (rows cascade; secrets must be revoked explicitly). */
  async refsFor(connectionIds: readonly string[]): Promise<string[]> {
    const refs: string[] = [];
    for (const id of connectionIds) {
      const rows = await this.db.select({ ref: mcpOauthPending.pendingRef }).from(mcpOauthPending).where(eq(mcpOauthPending.connectionId, id));
      refs.push(...rows.map((r) => r.ref));
    }
    return refs;
  }
}
