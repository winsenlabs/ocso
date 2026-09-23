import pg from 'pg';

/**
 * Scheduler leadership via a session-level advisory lock held on a dedicated
 * connection (ADR-018). If this process or its connection dies, PostgreSQL
 * releases the lock and another worker becomes leader.
 */
export class LeaderElection {
  private client: pg.Client | null = null;
  private leader = false;

  constructor(
    private readonly connectionString: string,
    private readonly lockKey: string,
  ) {}

  get isLeader(): boolean {
    return this.leader;
  }

  /** Try to (re)acquire leadership; cheap when already leader. */
  async tick(): Promise<boolean> {
    try {
      if (!this.client) {
        const client = new pg.Client({ connectionString: this.connectionString, application_name: 'ocso-scheduler' });
        client.on('error', () => this.reset());
        await client.connect();
        this.client = client;
      }
      if (this.leader) {
        await this.client.query('SELECT 1');
        return true;
      }
      const { rows } = await this.client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [this.lockKey]);
      this.leader = rows[0]?.ok === true;
      return this.leader;
    } catch {
      this.reset();
      return false;
    }
  }

  async release(): Promise<void> {
    const client = this.client;
    this.reset();
    await client?.end().catch(() => {});
  }

  private reset(): void {
    this.leader = false;
    const client = this.client;
    this.client = null;
    void client?.end().catch(() => {});
  }
}
