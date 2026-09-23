import { definePlugin } from '@winsendotai/ocso-plugin-sdk';
import { createJsonWebhookAdapter } from './adapter.js';

export { createJsonWebhookAdapter, IDENTITY_KIND, KIND } from './adapter.js';
export { SIGNATURE_HEADER, sign } from './signature.js';

/** The plugin OCSO loads: its default export. */
const plugin = definePlugin({
  apiVersion: 1,
  name: '@ocso-examples/ocso-plugin-example-channel',
  channels: [createJsonWebhookAdapter],
});

export default plugin;
