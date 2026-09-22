import {
  DescribeScalableTargetsCommand,
  DescribeScalingPoliciesCommand,
  PutScalingPolicyCommand,
  RegisterScalableTargetCommand,
  type ScalableTarget,
  type ScalingPolicy,
} from '@aws-sdk/client-application-auto-scaling';
import { DescribeAlarmsCommand, PutMetricAlarmCommand, PutMetricDataCommand, type MetricAlarm } from '@aws-sdk/client-cloudwatch';
import { DescribeServicesCommand, type Service } from '@aws-sdk/client-ecs';
import type { EcsAdapterClients } from '../src/index.js';

export interface FakeAwsState {
  target: ScalableTarget | null;
  policies: Map<string, ScalingPolicy>;
  alarms: Map<string, MetricAlarm>;
  service: Service | null;
  /** Throw this from the named command (e.g. AccessDenied). */
  failOn?: { command: string; error: Error } | undefined;
}

export interface Call {
  command: string;
  input: Record<string, unknown>;
}

export const MUTATING = new Set(['RegisterScalableTargetCommand', 'PutScalingPolicyCommand', 'PutMetricAlarmCommand', 'DeleteScalingPolicyCommand', 'DeleteAlarmsCommand']);

/** In-memory Application Auto Scaling + CloudWatch + ECS that echo what was put. */
export function fakeAws(initial: Partial<FakeAwsState> = {}) {
  const state: FakeAwsState = {
    target: { ServiceNamespace: 'ecs', ResourceId: 'service/ocso-prod/worker', ScalableDimension: 'ecs:service:DesiredCount', MinCapacity: 1, MaxCapacity: 10, RoleARN: 'arn:role', CreationTime: new Date(0) },
    policies: new Map(),
    alarms: new Map(),
    service: { serviceName: 'worker', status: 'ACTIVE', desiredCount: 2, runningCount: 2, pendingCount: 0, deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }] },
    ...initial,
  };
  const calls: Call[] = [];

  async function send(cmd: object): Promise<unknown> {
    const command = cmd.constructor.name;
    const input = (cmd as { input: Record<string, unknown> }).input;
    calls.push({ command, input });
    if (state.failOn?.command === command) throw state.failOn.error;
    if (cmd instanceof DescribeScalableTargetsCommand) return { ScalableTargets: state.target ? [state.target] : [] };
    if (cmd instanceof RegisterScalableTargetCommand) {
      state.target = { ...state.target!, MinCapacity: cmd.input.MinCapacity, MaxCapacity: cmd.input.MaxCapacity };
      return {};
    }
    // Real AWS filters by PolicyNames; the fake returns everything to prove the adapter filters too.
    if (cmd instanceof DescribeScalingPoliciesCommand) return { ScalingPolicies: [...state.policies.values()] };
    if (cmd instanceof PutScalingPolicyCommand) {
      const name = cmd.input.PolicyName!;
      const arn = state.policies.get(name)?.PolicyARN ?? `arn:aws:autoscaling:policy/${name}`;
      state.policies.set(name, { ...cmd.input, PolicyARN: arn, CreationTime: new Date(0) } as ScalingPolicy);
      return { PolicyARN: arn };
    }
    if (cmd instanceof DescribeAlarmsCommand) return { MetricAlarms: (cmd.input.AlarmNames ?? []).flatMap((n) => state.alarms.get(n) ?? []) };
    if (cmd instanceof PutMetricAlarmCommand) {
      state.alarms.set(cmd.input.AlarmName!, { ...(cmd.input as MetricAlarm), StateValue: 'OK' });
      return {};
    }
    if (cmd instanceof PutMetricDataCommand) return {};
    if (cmd instanceof DescribeServicesCommand) return state.service ? { services: [state.service], failures: [] } : { services: [], failures: [{ reason: 'MISSING' }] };
    throw new Error(`unexpected command ${command}`);
  }

  const client = { send } as unknown as EcsAdapterClients['autoscaling'];
  const clients: EcsAdapterClients = {
    autoscaling: client,
    cloudwatch: client as unknown as EcsAdapterClients['cloudwatch'],
    ecs: client as unknown as EcsAdapterClients['ecs'],
  };
  return {
    state,
    calls,
    clients,
    mutations: () => calls.filter((c) => MUTATING.has(c.command)),
    reset: () => calls.splice(0, calls.length),
  };
}

export function awsError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}
