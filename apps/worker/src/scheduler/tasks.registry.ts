import type { ScheduledTask } from './scheduler.service.js';

/**
 * Additional leader tasks contributed by subsystems (MCP health checks, alert
 * evaluation, metric publication). Kept separate so the core schedule stays small.
 */
export const EXTRA_TASKS: ScheduledTask[] = [];
