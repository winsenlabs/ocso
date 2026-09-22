/**
 * Deployment adapter contract (docs/13 §4, ADR-023). The Tech Admin edits
 * logical worker settings; the adapter maps them onto what the platform can
 * enforce. Compose cannot enforce anything (replicas are operator-controlled),
 * so it answers with advice; ECS applies them through Application Auto
 * Scaling and CloudWatch. Product code never branches on the driver.
 */

export type DeploymentDriver = 'compose' | 'ecs';

/** The scaling-relevant subset of worker_settings (docs/10 §5). */
export interface ScalingSettings {
  autoscalingEnabled: boolean;
  minWarmWorkers: number;
  maxWorkers: number;
  /** Turn slots per worker; also the per-worker turn concurrency. */
  conversationsPerWorker: number;
  /** Fraction of slots in use that target tracking aims for (0–1]. */
  targetUtilization: number;
  scaleOutQueueAgeSeconds: number;
  scaleOutQueueDepth: number;
  scaleInCooldownSeconds: number;
}

/** One sample of the fleet's load, computed from PostgreSQL by the leader. */
export interface ScalingSample {
  at: Date;
  /** Turns in flight plus queued conversation.turn wake-ups ("active + queued"). */
  slotDemand: number;
  /** Workers with status HEALTHY and a fresh heartbeat. */
  workers: number;
  /** Age of the oldest waiting turn; 0 when nothing waits. */
  oldestQueueAgeSeconds: number;
  /** Busy conversation leases. */
  turnsInFlight: number;
  /** p95 of completed-turn latency over the last 5 minutes; null without data. */
  turnLatencyP95Ms: number | null;
}

export interface EffectiveScaling {
  /** Whether dynamic scaling can move capacity (false = pinned). */
  autoscaling: boolean;
  minCapacity: number;
  maxCapacity: number;
  /** Target-tracking value: slot demand per worker. Null when not applicable. */
  targetSlotDemandPerWorker: number | null;
  queueAgeThresholdSeconds: number | null;
  scaleInCooldownSeconds: number | null;
  scaleOutCooldownSeconds: number | null;
}

export interface ScalingApplyResult {
  driver: DeploymentDriver;
  /** APPLIED: the platform now enforces the settings. ADVISORY: an operator must act. */
  outcome: 'APPLIED' | 'ADVISORY';
  /** One operator-facing paragraph. */
  message: string;
  /** Exact commands the operator should run (Compose), empty otherwise. */
  commands: string[];
  /** Platform changes made by this call; empty when already in sync. */
  changes: string[];
  /** Settings this driver cannot honour, clamped values, outside interference. */
  warnings: string[];
  effective: EffectiveScaling;
}

export interface ComposeDeploymentStatus {
  driver: 'compose';
  checkedAt: string;
  replicaControl: 'operator';
  note: string;
}

export interface EcsDeploymentStatus {
  driver: 'ecs';
  checkedAt: string;
  cluster: string;
  service: string;
  /** ECS service status (ACTIVE, DRAINING, INACTIVE) or MISSING. */
  serviceStatus: string;
  desiredCount: number | null;
  runningCount: number | null;
  pendingCount: number | null;
  /** Rollout state of the primary deployment (COMPLETED, IN_PROGRESS, FAILED). */
  rolloutState: string | null;
  scalableTarget: { minCapacity: number; maxCapacity: number; dynamicScalingSuspended: boolean } | null;
  policies: Array<{ name: string; type: 'TargetTrackingScaling' | 'StepScaling'; present: boolean }>;
  alarms: Array<{ name: string; state: 'OK' | 'ALARM' | 'INSUFFICIENT_DATA' | 'MISSING' }>;
}

export type DeploymentStatus = ComposeDeploymentStatus | EcsDeploymentStatus;

/**
 * Scale-in protection for the task running this process, held only while a
 * turn runs (research/05 §2). Reference-counted; failures are logged, never
 * thrown into the turn.
 */
export interface TaskProtection {
  readonly mode: 'ecs-agent' | 'none';
  /** Turns currently holding protection. */
  readonly holders: number;
  /** Run `fn` while holding protection. `turnTimeoutSeconds` sizes the expiry. */
  around<T>(fn: () => Promise<T>, options: { turnTimeoutSeconds: number }): Promise<T>;
  /** Resolves once queued protection updates have been sent (tests, shutdown). */
  settled(): Promise<void>;
}

export interface DeploymentAdapter {
  readonly driver: DeploymentDriver;
  /** False when publishMetrics is a no-op, so the leader can skip sampling. */
  readonly publishesMetrics: boolean;
  describe(): Promise<DeploymentStatus>;
  /** Idempotent: calling it again with the same settings changes nothing. */
  applyScaling(input: ScalingSettings): Promise<ScalingApplyResult>;
  publishMetrics(sample: ScalingSample): Promise<void>;
  /** The protection handle for this process (one per adapter). */
  taskProtection(): TaskProtection;
}

/** Structural logger (pino-compatible) so this package stays framework-free. */
export interface DeploymentLogger {
  warn(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
}

export const silentLogger: DeploymentLogger = { warn: () => {}, info: () => {} };
