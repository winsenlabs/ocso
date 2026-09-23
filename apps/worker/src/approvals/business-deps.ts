import type { Provider } from '@nestjs/common';
import { ChannelRuntime, templateProviderSource } from '@ocso/agent-runtime';
import { AuthMailer, type BusinessApprovalDeps } from '@ocso/application';
import { createAlertDeliveryRegistry, type OcsoPlugin } from '@ocso/bootstrap';
import type { WorkerEnv } from '@ocso/config';
import type { Db } from '@ocso/db';
import type { EmailSender } from '@ocso/email';
import type { QueueAdapter } from '@ocso/queue';
import { DB, EMAIL_SENDER, ENV, PLUGINS, QUEUE } from '../infrastructure/tokens.js';

/** What COVERAGE-BUSINESS deferred activations need in the worker (`createApprovalRegistry({ business })`). */
export const BUSINESS_APPROVAL_DEPS = Symbol('BUSINESS_APPROVAL_DEPS');

export const businessApprovalDepsProvider: Provider = {
  provide: BUSINESS_APPROVAL_DEPS,
  inject: [DB, ChannelRuntime, EMAIL_SENDER, ENV, QUEUE, PLUGINS],
  useFactory: (db: Db, channels: ChannelRuntime, sender: EmailSender, env: WorkerEnv, queue: QueueAdapter, plugins: readonly OcsoPlugin[]): BusinessApprovalDeps => ({
    // Message templates: an approved draft is submitted to (and an approved deletion made at) the channel's provider.
    templateProviders: templateProviderSource(channels),
    // Users: the invite sent once a new user's creation is approved.
    authMailer: new AuthMailer({ db, sender, publicUrl: env.OCSO_PUBLIC_URL }),
    // Alert rules: which destinations (plugin kinds included) hear RESOLVED when a deleted rule's alerts close. Only
    // `receives` is used here; the delivery itself is the alert.deliver consumer's.
    alertRouting: createAlertDeliveryRegistry({ fetch: () => Promise.reject(new Error('alert routing only')) }, plugins),
    alertQueue: queue,
  }),
};
