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
  /** Errors on idle pooled connections (server restart, failover, admin termination). */
  onError?: ((err: Error) => void) | undefined;
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
  // Without a listener an idle-connection error (e.g. 57P01 on failover) is an uncaught 'error' event
  // and kills the process. The pool drops that client; the next query opens a fresh connection.
  pool.on('error', (err) => {
    if (options.onError) options.onError(err);
    else process.stderr.write(`${JSON.stringify({ level: 'warn', msg: 'idle database connection lost', code: (err as { code?: string }).code ?? null })}\n`);
  });
  const db = drizzle({ client: pool, schema, casing: 'snake_case' });
  return { db, pool, close: () => pool.end() };
}
