import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { AuditRecord } from '../src/contract.js';
import { provisionPostgresAuditStore } from '../src/postgres/provision.js';

/** Same server as the rest of the integration suite (OCSO_TEST_DATABASE_URL). */
export const adminUrl = () => process.env['OCSO_TEST_DATABASE_URL'] ?? 'postgres://localhost:5432/postgres';

export interface ScratchAuditDb {
  ownerUrl: string;
  writerUrl: string;
  readerUrl: string;
  role: string;
  drop(): Promise<void>;
}

/** A provisioned audit database with its own writer role (this package cannot use @ocso/db/testing). */
export async function scratchAuditDb(): Promise<ScratchAuditDb> {
  const suffix = randomBytes(5).toString('hex');
  const name = `ocso_audit_pkg_${suffix}`;
  const role = `ocso_audit_pw_${suffix}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const owner = new URL(adminUrl());
  owner.pathname = `/${name}`;
  const writer = new URL(owner.toString());
  writer.username = role;
  writer.password = randomBytes(10).toString('hex');
  const reader = new URL(owner.toString());
  reader.username = `${role}_r`;
  reader.password = randomBytes(10).toString('hex');
  await provisionPostgresAuditStore({ ownerUrl: owner.toString(), writerUrl: writer.toString(), readerUrl: reader.toString(), provisionRole: true });
  return {
    ownerUrl: owner.toString(),
    writerUrl: writer.toString(),
    readerUrl: reader.toString(),
    role,
    async drop() {
      const c = new pg.Client({ connectionString: adminUrl() });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.query(`DROP ROLE IF EXISTS ${role}`);
      await c.query(`DROP ROLE IF EXISTS ${role}_r`);
      await c.end();
    },
  };
}

/** uuidv7-shaped ids sort by time like the main database's. */
export function recordAt(at: Date, overrides: Partial<AuditRecord> = {}): AuditRecord {
  const hex = at.getTime().toString(16).padStart(12, '0');
  const rand = randomUUID().replace(/-/g, '');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(3, 6)}-${rand.slice(6, 18)}`;
  return {
    id,
    occurredAt: at,
    actorType: 'USER',
    actorId: 'u-1',
    actorName: 'Asha',
    via: 'UI',
    action: 'agent.update',
    targetType: 'agent',
    targetId: 'a-1',
    summary: 'Updated Maya',
    before: { name: 'Maya', nested: { b: 2, a: 1 } },
    after: { name: 'Maya 2', list: [3, 1, 2] },
    correlationId: 'corr-1',
    confirmation: null,
    ip: '10.0.0.1',
    teamIds: [],
    ...overrides,
  };
}

export const daysAgo = (days: number, from = Date.now()) => new Date(from - days * 24 * 3600 * 1000);
