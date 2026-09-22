import pg from 'pg';
import type { QueueNotifier, Topic } from '@ocso/queue';

export const JOBS_CHANNEL = 'ocso_jobs';

type Listener = (channel: string, payload: string) => void;

/**
 * One dedicated LISTEN connection per process, shared by the queue wake-ups
 * and realtime event consumers. Reconnects with backoff; NOTIFY is best-effort
 * (queues still poll), so a dropped connection only adds latency.
 */
export class PgListener {
  private client: pg.Client | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly channels = new Set<string>();
  private stopped = false;

  constructor(private readonly connectionString: string, private readonly onError: (err: unknown) => void = () => {}) {}

  async start(channels: readonly string[]): Promise<void> {
    channels.forEach((c) => this.channels.add(c));
    await this.connect();
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.client?.end().catch(() => {});
    this.client = null;
  }

  private async connect(attempt = 0): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.connectionString, application_name: 'ocso-listener' });
    client.on('notification', (msg) => {
      for (const l of this.listeners) l(msg.channel, msg.payload ?? '');
    });
    client.on('error', (err) => {
      this.onError(err);
      this.client = null;
      setTimeout(() => void this.connect(attempt + 1), Math.min(30_000, 500 * 2 ** attempt));
    });
    try {
      await client.connect();
      for (const channel of this.channels) await client.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
      this.client = client;
    } catch (err) {
      this.onError(err);
      await client.end().catch(() => {});
      setTimeout(() => void this.connect(attempt + 1), Math.min(30_000, 500 * 2 ** attempt));
    }
  }
}

/** QueueNotifier backed by pg_notify + the shared listener (wakes PgQueue consumers). */
export function pgQueueNotifier(pool: pg.Pool, listener: PgListener): QueueNotifier {
  return {
    async notify(topic: Topic) {
      await pool.query('SELECT pg_notify($1, $2)', [JOBS_CHANNEL, topic]).catch(() => {});
    },
    onNotify(cb) {
      return listener.on((channel, payload) => {
        if (channel === JOBS_CHANNEL) cb(payload as Topic);
      });
    },
  };
}
