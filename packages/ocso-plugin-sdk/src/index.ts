/**
 * @winsendotai/ocso-plugin-sdk: the public contract for OCSO plugins.
 *
 * v0.1 (plugin API version 1) covers four plugin kinds: channels, model
 * providers, alert destinations and email drivers. Everything here is types
 * plus a few small pure helpers; the package has no runtime dependencies.
 * Conformance checks live in `@winsendotai/ocso-plugin-sdk/testing`.
 */
export { OCSO_PLUGIN_API_VERSION, definePlugin, type AlertDestinationFactory, type ChannelAdapterFactory, type OcsoPlugin, type OcsoPluginV1 } from './plugin.js';
export {
  ErrorCategory,
  RETRIABLE_CATEGORIES,
  isErrorCategory,
  isPluginError,
  pluginError,
  type OcsoErrorMarker,
  type OcsoPluginError,
} from './errors.js';
export * from './patterns.js';
export * from './domain.js';
export type * from './templates.js';
export type * from './channels.js';
export type * from './descriptor.js';
export {
  originAllowed,
  type EmbedAuthMode,
  type EmbedContext,
  type EmbedContextValues,
  type EmbedHeldUserToken,
  type EmbedSession,
  type EmbedSessionHooks,
  type EmbedSessionPass,
  type EmbedSessionPassRequest,
  type EmbedSessionRequest,
  type EmbedVisitor,
  type EmbedWidgetConfig,
  type EmbeddedChat,
} from './embed.js';
export type * from './model-providers.js';
export { ALERT_EVENTS, delivered, failed } from './alerts.js';
export type {
  AlertDeliveryAdapter,
  AlertEvent,
  AlertKind,
  AlertMessage,
  AlertSeverity,
  AlertStatus,
  ConfigCheck,
  DeliveryAdapterDeps,
  DeliveryResult,
  DestinationKind,
  FetchFn,
  MailTransport,
  MailTransportFactory,
  OutgoingMail,
  SecretRequirement,
  SmtpTransportOptions,
} from './alerts.js';
export type * from './email.js';
