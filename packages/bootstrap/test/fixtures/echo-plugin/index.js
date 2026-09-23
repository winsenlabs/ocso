// A stand-in for a plugin built with @winsendotai/ocso-plugin-sdk (plain ESM, no dependencies), for the
// loader tests. It copies the SDK's conventions: `definePlugin` returns its argument, and `pluginError`
// marks a plain Error with a non-enumerable `ocsoError: { category, code, details }`.

const definePlugin = (plugin) => plugin;

function pluginError(category, code, message, details) {
  const error = new Error(message);
  error.name = 'OcsoPluginError';
  Object.defineProperty(error, 'ocsoError', { value: Object.freeze({ category, code, details }), enumerable: false });
  return error;
}

/** ECHO: sends nothing anywhere; `send` answers with the text it was given. */
function createEchoChannel(deps) {
  return Object.freeze({
    kind: 'ECHO',
    describe: () => ({
      kind: 'ECHO',
      label: 'Echo (test)',
      description: 'Echoes outbound messages; for tests.',
      mark: { code: 'EC', name: 'Echo' },
      settingsSchema: { type: 'object', properties: { greeting: { type: 'string' } } },
      secrets: [{ key: 'token', label: 'Token', required: true, hint: 'any value' }],
      setupSteps: ['Nothing to set up.'],
      inboundWebhook: true,
      embeddable: false,
    }),
    capabilities: () => ({}),
    validateConfig: (_settings, secrets) => (secrets.token ? [] : ['token is required']),
    verifyRequest(req) {
      if (req.headers['x-echo-token'] === 'boom') throw new Error('plain failure');
      if (!req.headers['x-echo-token']) throw pluginError('authentication', 'echo_token_missing', 'The echo token is missing', { header: 'x-echo-token' });
      return { kind: 'verified' };
    },
    parseInbound: () => ({ messages: [], statuses: [], ignored: 0 }),
    async fetchMedia() {
      throw pluginError('not_found', 'echo_media_missing', 'Echo keeps no media');
    },
    render: (parts) => [{ kind: 'ECHO', payload: { parts: parts.length }, partIndexes: parts.map((_p, i) => i) }],
    async send(_target, message) {
      return { ok: true, externalMessageId: `echo-${deps.now().getTime()}-${message.partIndexes.length}` };
    },
  });
}

function createEchoAlerts() {
  return {
    kind: 'ECHO_ALERT',
    label: 'Echo alerts (test)',
    description: 'Records alerts; for tests.',
    events: ['OPENED', 'RESOLVED'],
    configSchema: { type: 'object', properties: {} },
    secret: null,
    validateConfig: (config) => ({ ok: true, config: config ?? {} }),
    validateSecret: () => [],
    summary: () => 'echo',
    async deliver() {
      throw pluginError('provider_unavailable', 'echo_alert_down', 'Echo alerts are down');
    },
  };
}

const echoEmailDriver = {
  name: 'echo-mail',
  label: 'Echo mail (test)',
  delivers: false,
  resolve: () => ({}),
  create: (_options, sender) => ({
    driver: 'echo-mail',
    from: sender.from,
    delivers: false,
    async send(message) {
      const to = [].concat(message.to);
      if (to.includes('reject@example.com')) throw pluginError('authentication', 'echo_mail_key_rejected', 'Echo mail rejected the API key', { status: 401 });
      if (to.includes('plain@example.com')) throw new Error('echo mail plain failure');
      throw pluginError('provider_rate_limited', 'echo_mail_throttled', 'Echo mail is throttled', { retryAfterSeconds: 5 });
    },
  }),
};

const echoProvider = {
  kind: 'ECHO_LLM',
  label: 'Echo LLM (test)',
  mark: 'EL',
  cachingSummary: 'none',
  devOnly: false,
  settingsSchema: { parse: (v) => v },
  credentialsSchema: { parse: (v) => v },
  capabilities: () => ({}),
  providerOptions: () => ({}),
  create: (config) => ({
    kind: 'ECHO_LLM',
    providerId: config.id,
    capabilities: () => ({}),
    async *stream() {
      yield { type: 'text-delta', text: 'hel' };
      throw pluginError('timeout', 'echo_stream_timeout', 'The echo stream timed out');
    },
    async generate() {
      throw pluginError('provider_unavailable', 'echo_llm_down', 'Echo LLM is down');
    },
    async health() {
      return { status: 'OK', latencyMs: 0, checkedAt: new Date(0).toISOString() };
    },
  }),
};

export default definePlugin({
  apiVersion: 1,
  name: '@acme/ocso-plugin-echo',
  channels: [createEchoChannel],
  modelProviders: [echoProvider],
  alertDestinations: [createEchoAlerts],
  emailDrivers: [echoEmailDriver],
});
