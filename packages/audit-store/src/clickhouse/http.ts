/**
 * A minimal ClickHouse HTTP interface client over an injected fetch (no SDK):
 * statements in the body, typed query parameters (`{name:Type}` bound from
 * `param_name`), JSONEachRow in and out. Credentials travel in the
 * X-ClickHouse-User / X-ClickHouse-Key headers, never in the URL.
 */
export interface ClickHouseConnection {
  url: string;
  database: string;
  user?: string | undefined;
  password?: string | undefined;
  fetch: typeof fetch;
  timeoutMs?: number | undefined;
}

export type ClickHouseParam = string | number | Date | readonly string[];

export class ClickHouseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'ClickHouseError';
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** DateTime64(3, 'UTC') text form. */
export function chDateTime(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

/** Escapes a value for ClickHouse's TSV-escaped parameter / string-literal format. */
const escapeText = (s: string) => s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/'/g, "\\'");

/** A single-quoted ClickHouse string literal (DDL cannot take parameters). */
export const chLiteral = (s: string) => `'${escapeText(s)}'`;

function encodeParam(v: ClickHouseParam): string {
  if (v instanceof Date) return chDateTime(v);
  if (Array.isArray(v)) return `[${v.map((s) => chLiteral(s)).join(',')}]`;
  return typeof v === 'number' ? String(v) : escapeText(v as string);
}

export class ClickHouseHttp {
  constructor(private readonly conn: ClickHouseConnection) {}

  get database(): string {
    return this.conn.database;
  }

  /** Runs a statement; returns the raw response body. */
  async exec(sql: string, options: { params?: Record<string, ClickHouseParam>; body?: string; settings?: Record<string, string | number>; database?: string | null; timeoutMs?: number } = {}): Promise<string> {
    const url = new URL(this.conn.url);
    if (options.database !== null) url.searchParams.set('database', options.database ?? this.conn.database);
    url.searchParams.set('date_time_output_format', 'iso');
    url.searchParams.set('output_format_json_quote_64bit_integers', '0');
    for (const [k, v] of Object.entries(options.settings ?? {})) url.searchParams.set(k, String(v));
    for (const [k, v] of Object.entries(options.params ?? {})) url.searchParams.set(`param_${k}`, encodeParam(v));
    let body = sql;
    if (options.body !== undefined) {
      url.searchParams.set('query', sql);
      body = options.body;
    }
    const headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8' };
    if (this.conn.user) headers['x-clickhouse-user'] = this.conn.user;
    if (this.conn.password) headers['x-clickhouse-key'] = this.conn.password;
    const res = await this.conn.fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(options.timeoutMs ?? this.conn.timeoutMs ?? 10_000) });
    const text = await res.text();
    if (!res.ok) {
      const code = res.headers.get('x-clickhouse-exception-code');
      throw new ClickHouseError(`ClickHouse ${res.status}${code ? ` (code ${code})` : ''}: ${text.slice(0, 400).trim()}`, res.status, code);
    }
    return text;
  }

  async query<T>(sql: string, params: Record<string, ClickHouseParam> = {}, settings: Record<string, string | number> = {}): Promise<T[]> {
    const text = await this.exec(`${sql} FORMAT JSONEachRow`, { params, settings });
    return text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as T);
  }

  async insert(table: string, rows: readonly Record<string, unknown>[], settings: Record<string, string | number> = {}): Promise<void> {
    if (!rows.length) return;
    await this.exec(`INSERT INTO ${table} FORMAT JSONEachRow`, {
      body: rows.map((r) => JSON.stringify(r)).join('\n'),
      settings: { date_time_input_format: 'best_effort', ...settings },
    });
  }
}
