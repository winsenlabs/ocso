import { eq } from 'drizzle-orm';
import { workerScalingState, type DbOrTx } from '@ocso/db';
import type { DeploymentDriver, DeploymentStatus, EffectiveScaling } from '@ocso/deployment';
import { SettingsService, type WorkerSettings } from '../settings/settings.js';
import type { Db } from '../shared/context.js';

/**
 * What the Tech Admin sees next to the worker settings: "applied",
 * "advisory" (with the exact operator command) or "failed: reason", and
 * PENDING while the newest change has not been applied yet.
 */
export interface WorkerScalingStatus {
  status: 'PENDING' | 'APPLIED' | 'ADVISORY' | 'FAILED';
  /** Outcome of the last attempt, even when a newer change is pending. */
  lastOutcome: 'APPLIED' | 'ADVISORY' | 'FAILED' | null;
  driver: DeploymentDriver | null;
  message: string;
  /** The adapter's advisory text when the platform needs an operator (Compose). */
  advisory: string | null;
  commands: string[];
  changes: string[];
  warnings: string[];
  effective: EffectiveScaling | null;
  attemptedAt: string | null;
  lastSucceededAt: string | null;
  /** worker_settings.updated_at of the settings the last attempt applied. */
  appliedSettingsAt: string | null;
  inSync: boolean;
}

export interface WorkerDeploymentView {
  driver: DeploymentDriver | null;
  /** Last successful describe() by the worker leader; null before the first one. */
  deployment: DeploymentStatus | null;
  describedAt: string | null;
  /** Why the latest describe failed (the snapshot above is then older). */
  describeError: string | null;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Read side for the API: serves what the worker leader recorded, no platform calls. */
export class ScalingStatusService {
  constructor(private readonly db: Db) {}

  async workers(db: DbOrTx = this.db, settings?: WorkerSettings): Promise<WorkerScalingStatus> {
    const current = settings ?? (await new SettingsService(this.db).workers(db));
    const [row] = await db.select().from(workerScalingState).where(eq(workerScalingState.id, 1));
    if (!row) {
      return {
        status: 'PENDING',
        lastOutcome: null,
        driver: null,
        message: 'Not applied yet: the worker leader applies worker settings when it starts and within seconds of every change.',
        advisory: null,
        commands: [],
        changes: [],
        warnings: [],
        effective: null,
        attemptedAt: null,
        lastSucceededAt: null,
        appliedSettingsAt: null,
        inSync: false,
      };
    }
    // Compare in JS: both timestamps went through JS Dates (millisecond precision).
    const inSync = row.settingsUpdatedAt.getTime() >= current.updatedAt.getTime();
    const detail = row.applyDetail;
    return {
      status: inSync ? row.applyStatus : 'PENDING',
      lastOutcome: row.applyStatus,
      driver: row.driver,
      message: inSync ? row.applyMessage : `The latest change has not been applied yet; the last attempt (${row.attemptedAt.toISOString()}) was ${row.applyStatus.toLowerCase()}: ${row.applyMessage}`,
      advisory: row.applyStatus === 'ADVISORY' ? row.applyMessage : null,
      commands: strings(detail['commands']),
      changes: strings(detail['changes']),
      warnings: strings(detail['warnings']),
      effective: (detail['effective'] as EffectiveScaling | undefined) ?? null,
      attemptedAt: row.attemptedAt.toISOString(),
      lastSucceededAt: row.lastSucceededAt?.toISOString() ?? null,
      appliedSettingsAt: row.settingsUpdatedAt.toISOString(),
      inSync,
    };
  }

  async deployment(db: DbOrTx = this.db): Promise<WorkerDeploymentView> {
    const [row] = await db.select().from(workerScalingState).where(eq(workerScalingState.id, 1));
    return {
      driver: row?.driver ?? null,
      deployment: (row?.deployment as DeploymentStatus | null | undefined) ?? null,
      describedAt: row?.describedAt?.toISOString() ?? null,
      describeError: row?.describeError ?? null,
    };
  }
}
