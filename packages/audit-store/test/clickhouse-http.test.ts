import { describe, expect, it } from 'vitest';
import { ClickHouseHttp, chDateTime, chLiteral } from '../src/clickhouse/http.js';
import { ClickHouseAuditStore } from '../src/clickhouse/store.js';
import { daysAgo, recordAt } from './support.js';

interface Seen {
  url: URL;
  headers: Record<string, string>;
  body: string;
}

/** A recorded-response fetch: every request is kept; `reply` decides the answer. */
function fakeFetch(reply: (req: Seen) => { status?: number; body?: string; headers?: Record<string, string> } = () => ({})) {
  const seen: Seen[] = [];
  const fetch = (async (input: URL | string, init?: RequestInit) => {
    const req = { url: new URL(String(input)), headers: init?.headers as Record<string, string>, body: String(init?.body ?? '') };
    seen.push(req);
    const r = reply(req);
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers ?? {} });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

const connection = (fetch: typeof globalThis.fetch) => new ClickHouseHttp({ url: 'http://clickhouse:8123', database: 'ocso_audit', user: 'writer', password: 's3cret', fetch });

describe('ClickHouse HTTP client', () => {
  it('sends credentials in headers only, typed parameters in the URL, statements in the body', async () => {
    const { fetch, seen } = fakeFetch(() => ({ body: '{"n":1}\n{"n":2}\n' }));
    const rows = await connection(fetch).query<{ n: number }>('SELECT n FROM t WHERE a = {a:String} AND t IN {ids:Array(UUID)}', { a: "it's\ta\\test", ids: ['x', 'y'] });
    expect(rows).toEqual([{ n: 1 }, { n: 2 }]);
    const [req] = seen;
    expect(req!.headers).toMatchObject({ 'x-clickhouse-user': 'writer', 'x-clickhouse-key': 's3cret' });
    expect(req!.url.toString()).not.toContain('s3cret');
    expect(req!.url.searchParams.get('database')).toBe('ocso_audit');
    expect(req!.url.searchParams.get('param_a')).toBe("it\\'s\\ta\\\\test");
    expect(req!.url.searchParams.get('param_ids')).toBe("['x','y']");
    expect(req!.body).toBe('SELECT n FROM t WHERE a = {a:String} AND t IN {ids:Array(UUID)} FORMAT JSONEachRow');
  });

  it('inserts JSONEachRow with the statement in the URL and settings as parameters', async () => {
    const { fetch, seen } = fakeFetch();
    await connection(fetch).insert('audit_chain', [{ a: 1 }, { a: 2 }], { insert_deduplication_token: 'tok' });
    expect(seen[0]!.url.searchParams.get('query')).toBe('INSERT INTO audit_chain FORMAT JSONEachRow');
    expect(seen[0]!.url.searchParams.get('insert_deduplication_token')).toBe('tok');
    expect(seen[0]!.body).toBe('{"a":1}\n{"a":2}');
  });

  it('turns an error response into a ClickHouseError with the server code', async () => {
    const { fetch } = fakeFetch(() => ({ status: 403, body: 'Code: 497. DB::Exception: writer: Not enough privileges.', headers: { 'x-clickhouse-exception-code': '497' } }));
    await expect(connection(fetch).exec('ALTER TABLE audit_records DELETE WHERE 1')).rejects.toMatchObject({ name: 'ClickHouseError', status: 403, code: '497' });
  });

  it('formats DateTime64 in UTC and escapes string literals', () => {
    expect(chDateTime(new Date('2026-01-02T03:04:05.006Z'))).toBe('2026-01-02 03:04:05.006');
    expect(chLiteral("pa'ss\\word")).toBe("'pa\\'ss\\\\word'");
  });
});

describe('ClickHouseAuditStore over the fake', () => {
  it('scopes reads with typed parameters and reads the replacing table with FINAL', async () => {
    const { fetch, seen } = fakeFetch(() => ({ body: '' }));
    await new ClickHouseAuditStore(connection(fetch)).query({ limit: 10, actionPrefix: 'agent.' }, { actorId: 'u1', teamIds: ['t1'], sharedTargetTypes: ['queue'] });
    expect(seen[0]!.body).toMatch(/FROM audit_records WHERE \(actor_id = \{s_actor:String\} OR hasAny\(team_ids, \{s_teams:Array\(UUID\)\}\)/);
    // First copy per id wins: a later insert of the same id never replaces what was stored.
    expect(seen[0]!.body).toMatch(/ORDER BY occurred_at DESC, id_s DESC, ingested_at LIMIT 1 BY id_s LIMIT \{limit:UInt32\}/);
    expect(seen[0]!.url.searchParams.get('param_s_teams')).toBe("['t1']");
    expect(seen[0]!.url.searchParams.get('param_action_prefix')).toBe('agent.');
  });

  it('never purges a month younger than 365 days, whatever the cutoff', async () => {
    const drops: string[] = [];
    let before = '';
    const { fetch } = fakeFetch((req) => {
      if (req.body.startsWith('ALTER TABLE')) drops.push(req.body);
      if (req.body.includes('toYYYYMM')) {
        before = req.url.searchParams.get('param_before')!;
        return { body: '{"p":202401,"n":"5"}\n' };
      }
      return {};
    });
    const removed = await new ClickHouseAuditStore(connection(fetch), connection(fetch)).purgeBefore(new Date());
    const floor = daysAgo(365);
    expect(before.slice(0, 7)).toBe(`${floor.getUTCFullYear()}-${String(floor.getUTCMonth() + 1).padStart(2, '0')}`);
    expect(drops).toEqual(['ALTER TABLE audit_records DROP PARTITION 202401']);
    expect(removed).toBe(5);
  });

  it('appends records as JSON text payloads and UUID team arrays', async () => {
    const { fetch, seen } = fakeFetch();
    const r = recordAt(new Date('2026-09-01T10:00:00.000Z'), { teamIds: ['0199aaaa-0000-7000-8000-000000000001'] });
    await new ClickHouseAuditStore(connection(fetch)).append([r]);
    const row = JSON.parse(seen[0]!.body) as Record<string, unknown>;
    expect(row).toMatchObject({ id: r.id, occurred_at: '2026-09-01 10:00:00.000', before: JSON.stringify(r.before), team_ids: r.teamIds, confirmation: null });
  });
});
