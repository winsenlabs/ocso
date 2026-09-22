import { setTimeout as sleep } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { conflict, notFound } from '@ocso/domain';
import type { Db } from '@ocso/db';
import type { CredentialPort, TokensRefreshedEvent } from '@ocso/mcp';
import type { SecretStore } from '@ocso/secrets';

export type SecretCasResult = { stored: true; version: number } | { stored: false; currentVersion: number | null };

const LOCK_ATTEMPTS = 60;

/**
 * Compare-and-swap rotation of a secret: rotate only while the stored version
 * is still `expectedVersion`. Writers are serialized by a transaction-scoped
 * advisory lock taken with `pg_try_advisory_xact_lock` + backoff, so a
 * waiting writer never holds a pool connection while the lock holder needs
 * one for the SecretStore (no pool-exhaustion deadlock).
 */
export async function compareAndRotateSecret(
  db: Db,
  secrets: SecretStore,
  ref: string,
  expectedVersion: number | null,
  value: string,
): Promise<SecretCasResult> {
  const key = `ocso:secret:${ref}`;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    const outcome = await db.transaction(async (tx) => {
      const lock = await tx.execute<{ ok: boolean }>(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS ok`);
      if (!lock.rows[0]?.ok) return null;
      const current = await secrets.describe(ref);
      if (!current) return { stored: false, currentVersion: null } as const;
      if (expectedVersion === null || current.version !== expectedVersion) return { stored: false, currentVersion: current.version } as const;
      const next = await secrets.rotate(ref, value);
      return { stored: true, version: next.version } as const;
    });
    if (outcome) return outcome;
    await sleep(10 + Math.floor(Math.random() * 40));
  }
  throw conflict('secret_rotation_contended', 'Could not lock the secret for rotation');
}

export interface SecretCredentialPortHooks {
  /** Another process rotated the tokens first: drop cached sessions so the next use re-reads the winner's state. */
  onSuperseded?: ((connectionId: string) => void) | undefined;
}

/**
 * CredentialPort over the SecretStore (ADR-012). Remembers the secret version
 * it resolved, and persists refreshed OAuth tokens with compare-and-swap on
 * that version: if a concurrent worker rotated the grant first, this write is
 * dropped (the stored, newer refresh token wins) instead of overwriting it.
 */
export class SecretCredentialPort implements CredentialPort {
  private readonly versions = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    private readonly hooks: SecretCredentialPortHooks = {},
  ) {}

  async resolve(ref: string): Promise<string> {
    // Read the version before and after the value so the recorded version never runs ahead of the value used.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.secrets.describe(ref);
      if (!before) throw notFound('secret', ref);
      const value = await this.secrets.resolve(ref);
      const after = await this.secrets.describe(ref);
      if (after?.version === before.version) {
        this.versions.set(ref, before.version);
        return value;
      }
    }
    throw conflict('secret_rotating', 'Secret changed while being read');
  }

  /** Version last read or written through this port (`null` when never resolved). */
  versionOf(ref: string): number | null {
    return this.versions.get(ref) ?? null;
  }

  async onTokensRefreshed(event: TokensRefreshedEvent): Promise<void> {
    const result = await compareAndRotateSecret(this.db, this.secrets, event.tokenRef, this.versionOf(event.tokenRef), event.serialized);
    if (result.stored) {
      this.versions.set(event.tokenRef, result.version);
      return;
    }
    this.versions.delete(event.tokenRef);
    this.hooks.onSuperseded?.(event.connectionId);
  }

  /** True when the stored secret moved on since this port read it (another worker refreshed). */
  async isStale(ref: string): Promise<boolean> {
    const known = this.versionOf(ref);
    const current = await this.secrets.describe(ref);
    return known === null || !current || current.version !== known;
  }
}
