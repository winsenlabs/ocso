import type { ScalingSettings } from './contract.js';

/**
 * The scheduler leader (a worker) publishes the scaling metrics and applies
 * settings, so a fleet of zero could never scale itself back out: every
 * driver keeps at least one worker running.
 */
export const MIN_FLEET_SIZE = 1;

export interface CapacityBounds {
  min: number;
  max: number;
  warnings: string[];
}

/** Capacity bounds implied by the settings; pinned (min = max) when autoscaling is off. */
export function capacityBounds(s: ScalingSettings): CapacityBounds {
  const warnings: string[] = [];
  const floor = Math.max(MIN_FLEET_SIZE, Math.trunc(s.minWarmWorkers));
  if (floor !== s.minWarmWorkers) {
    warnings.push(
      `Minimum warm workers ${s.minWarmWorkers} raised to ${floor}: the worker leader publishes the scaling signals, so the fleet never scales to zero.`,
    );
  }
  if (!s.autoscalingEnabled) return { min: floor, max: floor, warnings };
  return { min: floor, max: Math.max(floor, Math.trunc(s.maxWorkers)), warnings };
}

/** Target-tracking value: busy-or-waiting conversations per worker (ADR-023). */
export function targetSlotDemandPerWorker(s: ScalingSettings): number {
  return Math.round(s.conversationsPerWorker * s.targetUtilization * 1000) / 1000;
}
