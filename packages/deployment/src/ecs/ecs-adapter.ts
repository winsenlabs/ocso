import {
  ApplicationAutoScalingClient,
  DescribeScalableTargetsCommand,
  DescribeScalingPoliciesCommand,
  PutScalingPolicyCommand,
  RegisterScalableTargetCommand,
  type ScalableTarget,
  type ScalingPolicy,
} from '@aws-sdk/client-application-auto-scaling';
import { CloudWatchClient, DescribeAlarmsCommand, PutMetricAlarmCommand, PutMetricDataCommand, type MetricAlarm } from '@aws-sdk/client-cloudwatch';
import { DescribeServicesCommand, ECSClient } from '@aws-sdk/client-ecs';
import { capacityBounds, targetSlotDemandPerWorker } from '../capacity.js';
import {
  silentLogger,
  type DeploymentAdapter,
  type DeploymentLogger,
  type EcsDeploymentStatus,
  type ScalingApplyResult,
  type ScalingSample,
  type ScalingSettings,
  type TaskProtection,
} from '../contract.js';
import { aws, deploymentMisconfigured, scalableTargetMissing } from '../errors.js';
import { NoTaskProtection } from '../no-protection.js';
import { stepScalingFingerprint, targetTrackingFingerprint } from './compare.js';
import { ecsFacts } from './facts.js';
import { metricData } from './metric-data.js';
import { DEFAULT_METRIC_DIMENSION_VALUE, SCALABLE_DIMENSION, SERVICE_NAMESPACE, defaultMetricsNamespace, ecsScalingNames, type EcsScalingNames } from './names.js';
import { SCALE_OUT_COOLDOWN_SECONDS, queueAgeAlarmPlan, stepScalingConfiguration, targetTrackingConfiguration, type MetricTarget } from './policies.js';
import { EcsAgentTaskProtection } from './task-protection.js';

/** Only `send` is used, so tests can pass fakes without a mocking library. */
export interface EcsAdapterClients {
  autoscaling: Pick<ApplicationAutoScalingClient, 'send'>;
  cloudwatch: Pick<CloudWatchClient, 'send'>;
  ecs: Pick<ECSClient, 'send'>;
}

export interface EcsDeploymentOptions {
  /** ECS_CLUSTER (name or ARN). Also the `<name>-<env>` prefix of OCSO's policy/alarm names. */
  cluster: string;
  /** ECS_WORKER_SERVICE (name or ARN). */
  service: string;
  /** OCSO_METRICS_NAMESPACE; defaults to Terraform's `OCSO/<cluster>`. */
  metricsNamespace?: string | undefined;
  metricDimensionValue?: string | undefined;
  region?: string | undefined;
  /** ECS_AGENT_URI; without it (e.g. outside a task) protection is a no-op. */
  agentUri?: string | undefined;
  logger?: DeploymentLogger | undefined;
  now?: (() => Date) | undefined;
  clients?: EcsAdapterClients | undefined;
  fetch?: typeof fetch | undefined;
}

/**
 * ECS Fargate (ADR-022/023): Tech Admin settings → the worker service's
 * scalable target (min/max), a target-tracking policy on slot demand per
 * worker, and a step policy fired by the queue-age alarm. Reconcile-style:
 * reads current state first and writes only what differs, by fixed names.
 */
export class EcsDeploymentAdapter implements DeploymentAdapter {
  readonly driver = 'ecs' as const;
  readonly publishesMetrics = true;
  readonly names: EcsScalingNames;
  private readonly metrics: MetricTarget;
  private readonly clients: EcsAdapterClients;
  private readonly protection: TaskProtection;
  private readonly now: () => Date;

  constructor(options: EcsDeploymentOptions) {
    if (!options.cluster.trim() || !options.service.trim()) throw deploymentMisconfigured('DEPLOYMENT_DRIVER=ecs requires ECS_CLUSTER and ECS_WORKER_SERVICE');
    this.names = ecsScalingNames(options.cluster, options.service);
    this.metrics = {
      namespace: options.metricsNamespace ?? defaultMetricsNamespace(options.cluster),
      dimensionValue: options.metricDimensionValue ?? DEFAULT_METRIC_DIMENSION_VALUE,
    };
    const region = options.region ? { region: options.region } : {};
    this.clients = options.clients ?? {
      autoscaling: new ApplicationAutoScalingClient(region),
      cloudwatch: new CloudWatchClient(region),
      ecs: new ECSClient(region),
    };
    this.now = options.now ?? (() => new Date());
    const logger = options.logger ?? silentLogger;
    if (options.agentUri) {
      this.protection = new EcsAgentTaskProtection({ agentUri: options.agentUri, logger, fetch: options.fetch });
    } else {
      logger.warn({}, 'ECS_AGENT_URI is not set: task scale-in protection is disabled');
      this.protection = new NoTaskProtection();
    }
  }

  get metricsNamespace(): string {
    return this.metrics.namespace;
  }

  taskProtection(): TaskProtection {
    return this.protection;
  }

  async applyScaling(s: ScalingSettings): Promise<ScalingApplyResult> {
    const n = this.names;
    const bounds = capacityBounds(s);
    const warnings = [...bounds.warnings];
    const changes: string[] = [];

    const target = await this.scalableTarget();
    if (!target) throw scalableTargetMissing(n.resourceId);
    const suspended = target.SuspendedState;
    if (s.autoscalingEnabled && (suspended?.DynamicScalingInSuspended || suspended?.DynamicScalingOutSuspended)) {
      warnings.push('Dynamic scaling is suspended on the scalable target (set outside OCSO); the policies cannot act until it is resumed.');
    }
    if (target.MinCapacity !== bounds.min || target.MaxCapacity !== bounds.max) {
      await aws('RegisterScalableTarget', () =>
        this.clients.autoscaling.send(
          new RegisterScalableTargetCommand({ ServiceNamespace: SERVICE_NAMESPACE, ScalableDimension: SCALABLE_DIMENSION, ResourceId: n.resourceId, MinCapacity: bounds.min, MaxCapacity: bounds.max }),
        ),
      );
      changes.push(`Scalable target ${n.resourceId}: min ${target.MinCapacity ?? '?'} → ${bounds.min}, max ${target.MaxCapacity ?? '?'} → ${bounds.max}`);
    }

    const effective = {
      autoscaling: s.autoscalingEnabled,
      minCapacity: bounds.min,
      maxCapacity: bounds.max,
      targetSlotDemandPerWorker: s.autoscalingEnabled ? targetSlotDemandPerWorker(s) : null,
      queueAgeThresholdSeconds: s.autoscalingEnabled ? s.scaleOutQueueAgeSeconds : null,
      scaleInCooldownSeconds: s.autoscalingEnabled ? s.scaleInCooldownSeconds : null,
      scaleOutCooldownSeconds: s.autoscalingEnabled ? SCALE_OUT_COOLDOWN_SECONDS : null,
    };
    if (!s.autoscalingEnabled) {
      // Policies and the alarm stay: Terraform owns their existence and would
      // recreate them; with min = max they cannot move capacity.
      const message = `Autoscaling is off: the ECS worker service is pinned to ${bounds.min} task(s) (min = max). The scaling policies stay in place but cannot move capacity until autoscaling is turned back on.`;
      return { driver: 'ecs', outcome: 'APPLIED', message, commands: [], changes, warnings, effective };
    }

    const policies = await this.policies();
    const tt = targetTrackingConfiguration(s, this.metrics);
    const currentTt = policies.get(n.targetTrackingPolicy);
    if (currentTt?.PolicyType !== 'TargetTrackingScaling' || targetTrackingFingerprint(currentTt.TargetTrackingScalingPolicyConfiguration) !== targetTrackingFingerprint(tt)) {
      await this.putPolicy(n.targetTrackingPolicy, { PolicyType: 'TargetTrackingScaling', TargetTrackingScalingPolicyConfiguration: tt });
      changes.push(`Target-tracking policy ${n.targetTrackingPolicy}: slot demand per worker ${tt.TargetValue}, scale-in cooldown ${s.scaleInCooldownSeconds} s`);
    }
    const step = stepScalingConfiguration();
    const currentStep = policies.get(n.stepPolicy);
    let stepArn = currentStep?.PolicyARN;
    if (currentStep?.PolicyType !== 'StepScaling' || stepScalingFingerprint(currentStep.StepScalingPolicyConfiguration) !== stepScalingFingerprint(step)) {
      stepArn = await this.putPolicy(n.stepPolicy, { PolicyType: 'StepScaling', StepScalingPolicyConfiguration: step });
      changes.push(`Step-scaling policy ${n.stepPolicy}: +1 task at the queue-age threshold, +3 at threshold + 60 s`);
    }
    if (!stepArn) throw deploymentMisconfigured(`PutScalingPolicy returned no ARN for ${n.stepPolicy}`);

    const alarm = queueAgeAlarmPlan({ name: n.queueAgeAlarm, thresholdSeconds: s.scaleOutQueueAgeSeconds, policyArn: stepArn, existing: await this.alarm(), metrics: this.metrics });
    warnings.push(...alarm.warnings);
    if (alarm.changed) {
      await aws('PutMetricAlarm', () => this.clients.cloudwatch.send(new PutMetricAlarmCommand(alarm.input)));
      changes.push(`Alarm ${n.queueAgeAlarm}: threshold ${s.scaleOutQueueAgeSeconds} s`);
    }
    const message =
      `The ECS worker service scales between ${bounds.min} and ${bounds.max} tasks. Target tracking holds slot demand per worker at ${effective.targetSlotDemandPerWorker} ` +
      `(${s.conversationsPerWorker} slots × ${Math.round(s.targetUtilization * 100)}%), and the queue-age alarm adds tasks once a turn has waited ${s.scaleOutQueueAgeSeconds} s. ` +
      `Queued turns count toward slot demand, so the queue-depth setting (${s.scaleOutQueueDepth}) needs no separate ECS rule.`;
    return { driver: 'ecs', outcome: 'APPLIED', message, commands: [], changes, warnings, effective };
  }

  async publishMetrics(sample: ScalingSample): Promise<void> {
    await aws('PutMetricData', () =>
      this.clients.cloudwatch.send(new PutMetricDataCommand({ Namespace: this.metrics.namespace, MetricData: metricData(sample, this.metrics.dimensionValue) })),
    );
  }

  async describe(): Promise<EcsDeploymentStatus> {
    const n = this.names;
    const [services, target, policies, alarm] = await Promise.all([
      aws('DescribeServices', () => this.clients.ecs.send(new DescribeServicesCommand({ cluster: n.cluster, services: [n.service] }))),
      this.scalableTarget(),
      this.policies(),
      this.alarm(),
    ]);
    const svc = services.services?.find((x) => x.serviceName === n.service) ?? services.services?.[0];
    const primary = svc?.deployments?.find((d) => d.status === 'PRIMARY');
    const status: Omit<EcsDeploymentStatus, 'facts'> = {
      driver: 'ecs',
      checkedAt: this.now().toISOString(),
      cluster: n.cluster,
      service: n.service,
      serviceStatus: svc?.status ?? 'MISSING',
      desiredCount: svc?.desiredCount ?? null,
      runningCount: svc?.runningCount ?? null,
      pendingCount: svc?.pendingCount ?? null,
      rolloutState: primary?.rolloutState ?? null,
      scalableTarget: target
        ? {
            minCapacity: target.MinCapacity ?? 0,
            maxCapacity: target.MaxCapacity ?? 0,
            dynamicScalingSuspended: Boolean(target.SuspendedState?.DynamicScalingInSuspended || target.SuspendedState?.DynamicScalingOutSuspended),
          }
        : null,
      policies: [
        { name: n.targetTrackingPolicy, type: 'TargetTrackingScaling', present: policies.has(n.targetTrackingPolicy) },
        { name: n.stepPolicy, type: 'StepScaling', present: policies.has(n.stepPolicy) },
      ],
      alarms: [{ name: n.queueAgeAlarm, state: alarm?.StateValue ?? 'MISSING' }],
    };
    return { ...status, facts: ecsFacts(status) };
  }

  private async scalableTarget(): Promise<ScalableTarget | undefined> {
    const out = await aws('DescribeScalableTargets', () =>
      this.clients.autoscaling.send(
        new DescribeScalableTargetsCommand({ ServiceNamespace: SERVICE_NAMESPACE, ScalableDimension: SCALABLE_DIMENSION, ResourceIds: [this.names.resourceId] }),
      ),
    );
    return out.ScalableTargets?.find((t) => t.ResourceId === this.names.resourceId);
  }

  /** OCSO's two policies, looked up by exact name only. */
  private async policies(): Promise<Map<string, ScalingPolicy>> {
    const n = this.names;
    const out = await aws('DescribeScalingPolicies', () =>
      this.clients.autoscaling.send(
        new DescribeScalingPoliciesCommand({
          ServiceNamespace: SERVICE_NAMESPACE,
          ScalableDimension: SCALABLE_DIMENSION,
          ResourceId: n.resourceId,
          PolicyNames: [n.targetTrackingPolicy, n.stepPolicy],
        }),
      ),
    );
    const mine = new Set([n.targetTrackingPolicy, n.stepPolicy]);
    return new Map((out.ScalingPolicies ?? []).filter((p) => p.PolicyName && mine.has(p.PolicyName)).map((p) => [p.PolicyName!, p]));
  }

  private async alarm(): Promise<MetricAlarm | undefined> {
    const out = await aws('DescribeAlarms', () => this.clients.cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: [this.names.queueAgeAlarm] })));
    return out.MetricAlarms?.find((a) => a.AlarmName === this.names.queueAgeAlarm);
  }

  private async putPolicy(name: string, config: Pick<ConstructorParameters<typeof PutScalingPolicyCommand>[0], 'PolicyType' | 'TargetTrackingScalingPolicyConfiguration' | 'StepScalingPolicyConfiguration'>): Promise<string | undefined> {
    const out = await aws('PutScalingPolicy', () =>
      this.clients.autoscaling.send(
        new PutScalingPolicyCommand({ PolicyName: name, ServiceNamespace: SERVICE_NAMESPACE, ScalableDimension: SCALABLE_DIMENSION, ResourceId: this.names.resourceId, ...config }),
      ),
    );
    return out.PolicyARN;
  }
}
