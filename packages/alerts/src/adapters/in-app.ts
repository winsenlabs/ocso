import { z } from 'zod';
import { checkConfig } from '../config-check.js';
import { delivered, type AlertDeliveryAdapter } from '../contract.js';

const InAppConfig = z.object({}).strict();
export type InAppConfig = z.infer<typeof InAppConfig>;

/**
 * In-app delivery is the alert row itself plus the realtime `alert.opened`
 * event (SSE fan-out). The adapter only records that nothing else is needed.
 */
export function createInAppAdapter(): AlertDeliveryAdapter<InAppConfig> {
  return {
    kind: 'IN_APP',
    label: 'In-app',
    secret: null,
    validateConfig: (config) => checkConfig(InAppConfig, config),
    validateSecret: () => [],
    deliver: async () => delivered(),
  };
}
