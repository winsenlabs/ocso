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
    description: "Opened alerts appear in the OCSO alert inbox for the rule's audience. No configuration needed.",
    events: ['OPENED'],
    configSchema: z.toJSONSchema(InAppConfig, { io: 'input' }) as Record<string, unknown>,
    secret: null,
    validateConfig: (config) => checkConfig(InAppConfig, config),
    validateSecret: () => [],
    summary: () => 'OCSO inbox',
    deliver: async () => delivered(),
  };
}
