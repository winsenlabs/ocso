/**
 * Minimal SQL port so the Postgres queue works with any driver (node-postgres
 * Pool satisfies it directly). Keeps the queue independent of the ORM.
 */
export interface SqlClient {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}
