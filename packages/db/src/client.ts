import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
/** A transaction handle has the same query surface as the database. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export interface DatabaseOptions {
  connectionString: string;
  maxConnections?: number | undefined;
  applicationName?: string | undefined;
  ssl?: boolean | undefined;
}

export interface Database {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDatabase(options: DatabaseOptions): Database {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    application_name: options.applicationName ?? 'ocso',
    ssl: options.ssl ? { rejectUnauthorized: true } : undefined,
  });
  const db = drizzle({ client: pool, schema, casing: 'snake_case' });
  return { db, pool, close: () => pool.end() };
}
