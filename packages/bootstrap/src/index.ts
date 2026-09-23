// The composition root: the plugin shape, the plugins compiled into this build, and every registry built from them.
export * from './plugin.js';
export * from './first-party.js';
export * from './channels.js';
export * from './model-adapters.js';
export * from './alerts.js';
export * from './tool-providers.js';
export * from './tools.js';
// Infrastructure drivers selected by configuration.
export * from './drivers/registry.js';
export * from './drivers/first-party.js';
export * from './adapters.js';
export * from './audit.js';
export * from './deployment.js';
export * from './pg-notifier.js';
