import { describe, expect, it } from 'vitest';
import type { ScalingPolicy } from '@aws-sdk/client-application-auto-scaling';
import { DeploymentError, EcsDeploymentAdapter, ecsScalingNames, metricData, type ScalingSettings } from '../src/index.js';
import { awsError, fakeAws } from './fake-aws.js';

const SETTINGS: ScalingSettings = {
  autoscalingEnabled: true,
  minWarmWorkers: 2,
  maxWorkers: 12,
  conversationsPerWorker: 10,
  targetUtilization: 0.75,
  scaleOutQueueAgeSeconds: 10,
  scaleOutQueueDepth: 20,
  scaleInCooldownSeconds: 180,
};

function adapter(aws: ReturnType<typeof fakeAws>) {
  return new EcsDeploymentAdapter({ cluster: 'ocso-prod', service: 'worker', metricsNamespace: 'OCSO/ocso-prod', clients: aws.clients, agentUri: 'http://agent' });
}

describe('ecs scaling names', () => {
  it('derives Terraform-contract names from cluster/service names or ARNs', () => {
    const n = ecsScalingNames('arn:aws:ecs:ap-south-1:123:cluster/ocso-prod', 'arn:aws:ecs:ap-south-1:123:service/ocso-prod/worker');
    expect(n).toMatchObject({
      resourceId: 'service/ocso-prod/worker',
      targetTrackingPolicy: 'ocso-prod-worker-slot-demand',
      stepPolicy: 'ocso-prod-worker-queue-age',
      queueAgeAlarm: 'ocso-prod-worker-queue-age-high',
      alarmPrefix: 'ocso-prod-worker-',
    });
  });

  it('defaults the metrics namespace to Terraform’s OCSO/<cluster>', () => {
    const aws = fakeAws();
    expect(new EcsDeploymentAdapter({ cluster: 'ocso-stg', service: 'worker', clients: aws.clients }).metricsNamespace).toBe('OCSO/ocso-stg');
  });
});

describe('EcsDeploymentAdapter.applyScaling', () => {
  it('maps settings onto the scalable target, both policies and the queue-age alarm', async () => {
    const aws = fakeAws();
    const result = await adapter(aws).applyScaling(SETTINGS);

    expect(result.outcome).toBe('APPLIED');
    expect(aws.mutations().map((c) => c.command)).toEqual(['RegisterScalableTargetCommand', 'PutScalingPolicyCommand', 'PutScalingPolicyCommand', 'PutMetricAlarmCommand']);
    expect(aws.state.target).toMatchObject({ MinCapacity: 2, MaxCapacity: 12 });

    const tt = aws.state.policies.get('ocso-prod-worker-slot-demand')!;
    expect(tt.PolicyType).toBe('TargetTrackingScaling');
    const cfg = tt.TargetTrackingScalingPolicyConfiguration!;
    expect(cfg).toMatchObject({ TargetValue: 7.5, ScaleInCooldown: 180, ScaleOutCooldown: 60 });
    const metrics = cfg.CustomizedMetricSpecification!.Metrics!;
    expect(metrics.map((m) => m.MetricStat?.Metric?.MetricName ?? m.Expression)).toEqual(['SlotDemand', 'Workers', 'IF(workers > 0, demand / workers, demand)']);
    expect(metrics[0]!.MetricStat!.Metric).toEqual({ Namespace: 'OCSO/ocso-prod', MetricName: 'SlotDemand', Dimensions: [{ Name: 'Service', Value: 'worker' }] });
    expect(metrics.filter((m) => m.ReturnData).map((m) => m.Id)).toEqual(['perworker']);

    const step = aws.state.policies.get('ocso-prod-worker-queue-age')!;
    expect(step.StepScalingPolicyConfiguration).toMatchObject({ AdjustmentType: 'ChangeInCapacity', MetricAggregationType: 'Maximum', Cooldown: 60 });
    const alarm = aws.state.alarms.get('ocso-prod-worker-queue-age-high')!;
    expect(alarm).toMatchObject({ Namespace: 'OCSO/ocso-prod', MetricName: 'OldestQueueAgeSeconds', Threshold: 10, Statistic: 'Maximum', ComparisonOperator: 'GreaterThanOrEqualToThreshold', AlarmActions: [step.PolicyARN] });
    expect(result.effective).toMatchObject({ minCapacity: 2, maxCapacity: 12, targetSlotDemandPerWorker: 7.5, queueAgeThresholdSeconds: 10 });
    expect(result.changes).toHaveLength(4);
  });

  it('is idempotent: a second apply with the same settings writes nothing', async () => {
    const aws = fakeAws();
    const a = adapter(aws);
    await a.applyScaling(SETTINGS);
    aws.reset();
    const again = await a.applyScaling(SETTINGS);
    expect(aws.mutations()).toEqual([]);
    expect(again.changes).toEqual([]);
  });

  it('re-puts only what changed', async () => {
    const aws = fakeAws();
    const a = adapter(aws);
    await a.applyScaling(SETTINGS);
    aws.reset();
    const result = await a.applyScaling({ ...SETTINGS, targetUtilization: 0.6 });
    expect(aws.mutations().map((c) => [c.command, c.input['PolicyName']])).toEqual([['PutScalingPolicyCommand', 'ocso-prod-worker-slot-demand']]);
    expect(aws.state.policies.get('ocso-prod-worker-slot-demand')!.TargetTrackingScalingPolicyConfiguration!.TargetValue).toBe(6);
    expect(result.changes).toHaveLength(1);
  });

  it('keeps the Terraform alarm’s metric and changes only the threshold', async () => {
    const aws = fakeAws();
    const stepArn = 'arn:aws:autoscaling:policy/ocso-prod-worker-queue-age';
    aws.state.policies.set('ocso-prod-worker-queue-age', { PolicyName: 'ocso-prod-worker-queue-age', PolicyARN: stepArn, PolicyType: 'StepScaling' } as ScalingPolicy);
    aws.state.alarms.set('ocso-prod-worker-queue-age-high', {
      AlarmName: 'ocso-prod-worker-queue-age-high',
      Namespace: 'AWS/SQS',
      MetricName: 'ApproximateAgeOfOldestMessage',
      Dimensions: [{ Name: 'QueueName', Value: 'ocso-prod-conversation-turn' }],
      Statistic: 'Maximum',
      Period: 60,
      EvaluationPeriods: 1,
      Threshold: 30,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      AlarmActions: [stepArn, 'arn:aws:sns:ops'],
      StateValue: 'OK',
    });
    await adapter(aws).applyScaling(SETTINGS);
    const put = aws.calls.find((c) => c.command === 'PutMetricAlarmCommand')!.input;
    expect(put).toMatchObject({ Namespace: 'AWS/SQS', MetricName: 'ApproximateAgeOfOldestMessage', Dimensions: [{ Name: 'QueueName', Value: 'ocso-prod-conversation-turn' }], Threshold: 10 });
    expect(put['AlarmActions']).toEqual([stepArn, 'arn:aws:sns:ops']);
    expect(put).not.toHaveProperty('StateValue');
  });

  it('never touches policies it does not own', async () => {
    const aws = fakeAws();
    aws.state.policies.set('ops-cpu-guard', { PolicyName: 'ops-cpu-guard', PolicyARN: 'arn:cpu', PolicyType: 'TargetTrackingScaling' } as ScalingPolicy);
    await adapter(aws).applyScaling(SETTINGS);
    const touched = aws.mutations().map((c) => c.input['PolicyName'] ?? c.input['AlarmName'] ?? c.input['ResourceId']);
    expect(touched).toEqual(['service/ocso-prod/worker', 'ocso-prod-worker-slot-demand', 'ocso-prod-worker-queue-age', 'ocso-prod-worker-queue-age-high']);
    expect(aws.calls.find((c) => c.command === 'DescribeScalingPoliciesCommand')!.input['PolicyNames']).toEqual(['ocso-prod-worker-slot-demand', 'ocso-prod-worker-queue-age']);
  });

  it('disabled: pins min = max = warm floor and leaves policies and alarm alone', async () => {
    const aws = fakeAws();
    const result = await adapter(aws).applyScaling({ ...SETTINGS, autoscalingEnabled: false, minWarmWorkers: 3 });
    expect(aws.mutations().map((c) => c.command)).toEqual(['RegisterScalableTargetCommand']);
    expect(aws.state.target).toMatchObject({ MinCapacity: 3, MaxCapacity: 3 });
    expect(result.effective).toMatchObject({ autoscaling: false, minCapacity: 3, maxCapacity: 3, targetSlotDemandPerWorker: null });
    expect(result.message).toMatch(/pinned to 3 task/);
  });

  it('never scales the fleet to zero (the leader publishes the signals)', async () => {
    const aws = fakeAws();
    const result = await adapter(aws).applyScaling({ ...SETTINGS, minWarmWorkers: 0 });
    expect(aws.state.target).toMatchObject({ MinCapacity: 1, MaxCapacity: 12 });
    expect(result.warnings.join(' ')).toMatch(/raised to 1/);
  });

  it('fails with a typed error when Terraform has not registered the target', async () => {
    const aws = fakeAws({ target: null });
    await expect(adapter(aws).applyScaling(SETTINGS)).rejects.toMatchObject({ code: 'scalable_target_missing' });
    expect(aws.mutations()).toEqual([]);
  });

  it('wraps AWS failures in DeploymentError with a category', async () => {
    const aws = fakeAws({ failOn: { command: 'PutScalingPolicyCommand', error: awsError('AccessDeniedException', 'not authorized to perform PutScalingPolicy') } });
    const err = await adapter(aws).applyScaling(SETTINGS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeploymentError);
    expect(err).toMatchObject({ category: 'policy_denied', code: 'deployment_aws_call_failed', details: { operation: 'PutScalingPolicy', awsError: 'AccessDeniedException' } });
    expect((err as Error).message).toContain('PutScalingPolicy failed: AccessDeniedException');
  });

  it('warns when dynamic scaling was suspended outside OCSO', async () => {
    const aws = fakeAws();
    aws.state.target = { ...aws.state.target!, SuspendedState: { DynamicScalingInSuspended: true } };
    const result = await adapter(aws).applyScaling(SETTINGS);
    expect(result.warnings.join(' ')).toMatch(/suspended/);
    expect(aws.calls.find((c) => c.command === 'RegisterScalableTargetCommand')!.input).not.toHaveProperty('SuspendedState');
  });
});

describe('EcsDeploymentAdapter metrics and describe', () => {
  const sample = { at: new Date('2026-09-22T10:00:00Z'), slotDemand: 17, workers: 3, oldestQueueAgeSeconds: 4.5, turnsInFlight: 12, turnLatencyP95Ms: 2300 };

  it('publishes the five ADR-023 metrics with only the Service dimension', async () => {
    const aws = fakeAws();
    await adapter(aws).publishMetrics(sample);
    const put = aws.calls.find((c) => c.command === 'PutMetricDataCommand')!.input as { Namespace: string; MetricData: Array<Record<string, unknown>> };
    expect(put.Namespace).toBe('OCSO/ocso-prod');
    expect(put.MetricData.map((d) => [d['MetricName'], d['Value'], d['Unit']])).toEqual([
      ['SlotDemand', 17, 'Count'],
      ['Workers', 3, 'Count'],
      ['OldestQueueAgeSeconds', 4.5, 'Seconds'],
      ['TurnsInFlight', 12, 'Count'],
      ['TurnLatencyP95', 2300, 'Milliseconds'],
    ]);
    for (const d of put.MetricData) expect(d['Dimensions']).toEqual([{ Name: 'Service', Value: 'worker' }]);
  });

  it('publishes zeros but omits latency without data', () => {
    const data = metricData({ ...sample, slotDemand: 0, workers: 0, oldestQueueAgeSeconds: 0, turnsInFlight: 0, turnLatencyP95Ms: null }, 'worker');
    expect(data.map((d) => [d.MetricName, d.Value])).toEqual([['SlotDemand', 0], ['Workers', 0], ['OldestQueueAgeSeconds', 0], ['TurnsInFlight', 0]]);
  });

  it('describes service counts, target bounds, policy presence and alarm state', async () => {
    const aws = fakeAws();
    const a = adapter(aws);
    await a.applyScaling(SETTINGS);
    const status = await a.describe();
    expect(status).toMatchObject({
      driver: 'ecs',
      serviceStatus: 'ACTIVE',
      desiredCount: 2,
      runningCount: 2,
      pendingCount: 0,
      rolloutState: 'COMPLETED',
      scalableTarget: { minCapacity: 2, maxCapacity: 12, dynamicScalingSuspended: false },
      policies: [{ present: true }, { present: true }],
      alarms: [{ name: 'ocso-prod-worker-queue-age-high', state: 'OK' }],
    });
    // The panel rows come from the driver, so the web app renders ECS without knowing it.
    expect(status.facts?.map((f) => f.label)).toEqual(['service', 'tasks', 'rollout', 'scalable target', 'policies', 'alarms']);
    expect(status.facts?.find((f) => f.label === 'tasks')?.value).toBe('desired 2 · running 2 · pending 0');
    expect(status.facts?.find((f) => f.label === 'alarms')?.states).toEqual([{ name: 'ocso-prod-worker-queue-age-high · ok', tone: 'good' }]);
    expect(aws.mutations()).toHaveLength(4);
  });
});
