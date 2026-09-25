import 'server-only';
import { serverEnv } from './env';

type D1Response = { success: boolean; errors?: { message: string }[]; result?: { results: unknown[] }[] };

/** Runs one statement against the site's D1 database over the Cloudflare REST API. */
export async function d1(sql: string, params: (string | null)[] = []) {
  const { accountId, apiToken, databaseId, missing } = serverEnv();
  if (missing.length) throw new Error(`D1 is not configured: ${missing.join(', ')}`);

  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => null)) as D1Response | null;
  if (!res.ok || !body?.success) {
    throw new Error(`D1 query failed (${res.status}): ${body?.errors?.map((e) => e.message).join('; ') ?? 'no body'}`);
  }
  return body.result?.[0]?.results ?? [];
}
