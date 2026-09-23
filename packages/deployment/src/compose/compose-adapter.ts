import { capacityBounds } from '../capacity.js';
import type {
  ComposeDeploymentStatus,
  DeploymentAdapter,
  ScalingApplyResult,
  ScalingSample,
  ScalingSettings,
  TaskProtection,
} from '../contract.js';
import { NoTaskProtection } from '../no-protection.js';

export interface ComposeDeploymentOptions {
  /** Compose service name of the worker (compose.yaml). */
  workerService?: string | undefined;
  now?: (() => Date) | undefined;
}

/**
 * Docker Compose (docs/13 §2): the operator owns the replica count, so every
 * scaling setting is advisory. The adapter turns the settings into the exact
 * command to run and says which settings Compose cannot enforce.
 */
export class ComposeDeploymentAdapter implements DeploymentAdapter {
  readonly driver = 'compose' as const;
  readonly publishesMetrics = false;
  private readonly protection = new NoTaskProtection();
  private readonly workerService: string;
  private readonly now: () => Date;

  constructor(options: ComposeDeploymentOptions = {}) {
    this.workerService = options.workerService ?? 'worker';
    this.now = options.now ?? (() => new Date());
  }

  async describe(): Promise<ComposeDeploymentStatus> {
    const note = 'Docker Compose does not report replica counts to OCSO; the worker registry shows the workers that are actually running.';
    return {
      driver: 'compose',
      checkedAt: this.now().toISOString(),
      replicaControl: 'operator',
      note,
      facts: [
        { label: 'replicas', value: 'managed by the operator (docker compose)' },
        { label: 'note', value: note },
      ],
    };
  }

  async applyScaling(s: ScalingSettings): Promise<ScalingApplyResult> {
    const { min, warnings } = capacityBounds(s);
    const command = `docker compose up -d --scale ${this.workerService}=${min}`;
    const unenforced = [
      `max workers (${s.maxWorkers})`,
      `target utilization (${Math.round(s.targetUtilization * 100)}%)`,
      `scale-out queue age (${s.scaleOutQueueAgeSeconds} s) and depth (${s.scaleOutQueueDepth})`,
      `scale-in cooldown (${s.scaleInCooldownSeconds} s)`,
    ];
    if (s.autoscalingEnabled) {
      warnings.push('Autoscaling is enabled in settings, but Docker Compose cannot scale on its own: an operator changes the replica count.');
    }
    const message =
      `Worker replicas are operator-controlled under Docker Compose. To run the warm floor of ${min} worker(s), run \`${command}\` on the host. ` +
      `Compose does not enforce ${unenforced.join(', ')}; raise the replica count by hand (up to ${Math.max(min, s.maxWorkers)}) when the queue age alert fires. ` +
      `Conversations per worker (${s.conversationsPerWorker}) is applied by every worker directly.`;
    return {
      driver: 'compose',
      outcome: 'ADVISORY',
      message,
      commands: [command],
      changes: [],
      warnings,
      effective: {
        autoscaling: false,
        minCapacity: min,
        maxCapacity: min,
        targetSlotDemandPerWorker: null,
        queueAgeThresholdSeconds: null,
        scaleInCooldownSeconds: null,
        scaleOutCooldownSeconds: null,
      },
    };
  }

  async publishMetrics(_sample: ScalingSample): Promise<void> {
    // No platform autoscaler consumes metrics under Compose.
  }

  taskProtection(): TaskProtection {
    return this.protection;
  }
}
